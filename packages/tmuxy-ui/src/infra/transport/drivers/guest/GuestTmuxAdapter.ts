/**
 * A fully client-side `TmuxAdapter` backed by REAL tmux in an in-browser
 * guest machine; its `tmux -CC` control-mode stream is parsed by the
 * tmuxy-core Rust engine compiled to WASM — the SAME code the native server
 * runs. No simulation, no client-side VT emulator.
 *
 *   TmuxyApp --invoke(run_tmux_command)--> engine.send --> real tmux -CC
 *     --guest stream--> tmuxy-wasm (parse + aggregate) --> ServerState --> onStateChange
 *
 * The machine and the wasm core live in a `GuestEngine` (`V86Engine`,
 * `CheerpXEngine`); this class is the `TmuxAdapter` facade over one. An
 * adapter that owns its engine tears it down on disconnect; one handed a
 * shared engine leaves it running for the next.
 *
 * Assets are served from the page's origin (Storybook staticDirs / demo
 * public): /wasm (tmuxy_wasm), plus what the engine's machine loads.
 * Browser-only.
 */
import type { TmuxAdapter } from '../../driver';
import { EventHub } from '../../../eventHub';
import { TransportEvent } from '../../events';
import { isPaneId } from '../../../../domain/ids';
import type { CommandFailure } from '../../../../domain/wire';
import { decodeServerStateOrThrow, decodeStateForListener } from '../../wireDecode';
import {
  saveThemeToStorage,
  loadThemeFromStorage,
  parseThemeMode,
} from '../../../../utils/themeManager';
import { unescapeLiteralText } from '../../keyBatching';
import { quote } from '../../../../domain/commands';
import { DEFAULT_KEYBINDINGS } from './defaultKeybindings';
import { readGuestPreview } from './guestPreview';
import {
  GUEST_DEFAULT_COLS,
  GUEST_DEFAULT_ROWS,
  type EngineSink,
  type GuestEngine,
  type GuestFile,
} from './GuestEngine';

/** Theme names bundled with tmuxy (mirrors the server's `get_themes_list`). */
const BUNDLED_THEMES: { name: string; displayName: string }[] = [
  { name: 'default', displayName: 'Default' },
  { name: 'dracula', displayName: 'Dracula' },
  { name: 'fallout', displayName: 'Fallout' },
  { name: 'gruvbox', displayName: 'Gruvbox' },
  { name: 'nord', displayName: 'Nord' },
  { name: 'solarized', displayName: 'Solarized' },
  { name: 'tokyonight', displayName: 'Tokyo Night' },
];

/**
 * Translate a frontend command for the raw control-mode stdin transport.
 *
 * The keyboardActor joins compound commands with a SHELL-escaped separator
 * ` \; ` (e.g. `select-pane -t %0 \; split-window -v`) — correct when a command
 * passes through a shell/`run-shell` context, as on the native server. But tmux's
 * control-mode parser reads stdin directly, where `\;` is a literal argument, not
 * a separator, so the whole command errors (and, for a split, the optimistic
 * placeholder pane never reconciles — the UI appears frozen). Control mode wants
 * a bare ` ; ` separator. We only rewrite the separator token, and never inside a
 * `send-keys -l` literal (which may legitimately contain `\;`).
 */
function toControlModeCommand(command: string): string {
  // Multi-line strings (e.g. a paste's per-line command batch) are one control
  // command per line — rewrite each independently.
  return command.split('\n').map(toControlModeLine).join('\n');
}

function toControlModeLine(line: string): string {
  const literal = line.match(/^(send-keys -t \S+ -l (?:-- )?)(.+)$/);
  if (literal) {
    // tmux 3.7a format-expands send-keys arguments, and no amount of `#`
    // doubling protects a valid `#{variable}` (`##{pane_id}` still yields
    // `#%0`). The only reliable transport-level fix: split the literal at every
    // `#`/`{` boundary so the two characters never share a format context —
    // each chunk is its own send-keys and the pane reassembles them verbatim.
    const text = unescapeLiteralText(literal[2]);
    if (!text.includes('#{')) return line;
    const parts = text.split(/(?<=#)(?={)/);
    return parts.map((part) => literal[1] + quote(part)).join('\n');
  }
  if (line.includes(' -l ')) return line;
  return line.replace(/ \\; /g, ' ; ');
}

export interface GuestTmuxAdapterOptions {
  /** tmux commands run once after attach (splits, new-window, …). */
  initCommands?: string[];
  /**
   * A global tmux option the init sets once everything it started is done
   * (`tmux set -g <option> 1` at the end of a shell line it typed, say).
   * connect() resolves only then, so the app's first frame is the finished
   * layout rather than every step on the way to it.
   */
  initDoneOption?: string;
  /**
   * Files the guest has in `GUEST_FILES_DIR` (`/mnt`) before the init runs,
   * by name: a string is the file's text, a URL is fetched by the page. A
   * fetch that fails leaves its file out rather than failing the start.
   */
  files?: Record<string, string | URL>;
}

/** The bytes of each file the options name; one that cannot be fetched is left out. */
export async function loadGuestFiles(files: Record<string, string | URL>): Promise<GuestFile[]> {
  const loaded = await Promise.all(
    Object.entries(files).map(async ([name, source]): Promise<GuestFile | null> => {
      if (typeof source === 'string') return { name, bytes: new TextEncoder().encode(source) };
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
      } catch (err) {
        console.warn(`[guest] ${name} is left out: ${source.href}:`, err);
        return null;
      }
    }),
  );
  return loaded.filter((file): file is GuestFile => file !== null);
}

export class GuestTmuxAdapter implements TmuxAdapter {
  private readonly initCommands: string[];
  private readonly initDoneOption: string | null;
  private readonly files: Record<string, string | URL>;
  /** The sink this adapter installed on the engine (null when detached). */
  private sink: EngineSink | null = null;

  readonly events = new EventHub<TransportEvent>();

  /** `ownsEngine`: tear the engine down on disconnect (false for a shared one). */
  constructor(
    private readonly engine: GuestEngine,
    private readonly ownsEngine: boolean,
    options?: GuestTmuxAdapterOptions,
  ) {
    this.initCommands = options?.initCommands ?? [];
    this.initDoneOption = options?.initDoneOption ?? null;
    this.files = options?.files ?? {};
  }

  async connect(): Promise<void> {
    // NB: do NOT emit a reconnection signal here. That drives the app machine
    // into its `reconnecting` state, so the subsequent TMUX_CONNECTED is handled
    // by the reconnect branch — which skips the initial theme + keybindings fetch
    // that only the `connecting` branch performs. The app already shows connecting
    // feedback via its own `connecting` state until connect() resolves.
    this.events.emit(TransportEvent.ConnectionInfo({ defaultShell: 'bash', readOnly: false }));
    this.events.emit(TransportEvent.KeyBindings({ keybindings: DEFAULT_KEYBINDINGS }));

    // reset() serializes on the engine's lifecycle queue: it gives a booted
    // engine a clean start (v86 restores its pinned snapshot), cold-boots
    // otherwise,
    // and queues behind any transition still in flight (a story switch can
    // call connect() before the previous story's boot/reset finished).
    // The option is cleared first, so a value left by an earlier start does
    // not end the wait at once.
    const done = this.initDoneOption;
    await this.engine.reset(
      done ? [`set -gu ${done}`, ...this.initCommands] : this.initCommands,
      await loadGuestFiles(this.files),
    );
    if (done) await this.engine.waitForOption(done);

    // Install our sink only AFTER the reset settled. Installing it before
    // would let the still-attached PREVIOUS story's core stream its final
    // states into this adapter's fresh machine (a dead active-window id the
    // new state never contains — the app then renders zero panes forever).
    // The engine tracks lastState independently of the sink, so the machine's
    // get_initial_state still returns the post-reset state.
    this.sink = {
      onState: (raw) => {
        // A sandbox engine emits a full state every time, so one that fails
        // its decode is simply dropped; the next one replaces it.
        const state = decodeStateForListener(raw);
        if (state) this.events.emit(TransportEvent.State({ state, seq: null }));
      },
      onClipboard: (paneId, text) => {
        const source = isPaneId(paneId) ? paneId : null;
        this.events.emit(TransportEvent.Clipboard({ paneId: source, text }));
      },
      onFatal: (message) => this.events.emit(TransportEvent.Fatal({ message })),
    };
    this.engine.setSink(this.sink);
  }

  disconnect(): void {
    // Detach OUR sink so an unmounted story never receives further state —
    // but never a successor's: this cleanup can run after the next story's
    // adapter already installed its own sink on the shared engine.
    if (this.sink) this.engine.clearSink(this.sink);
    this.sink = null;
    // A private engine is torn down; a shared engine stays alive for reuse.
    if (this.ownsEngine) this.engine.destroy();
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    switch (cmd) {
      case 'get_initial_state': {
        // Sized to the client's viewport first, as the native server does, so
        // the first frame is drawn at the size it stays at.
        const cols = args?.cols;
        const rows = args?.rows;
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
          await this.engine.resize(cols, rows);
        }
        return decodeServerStateOrThrow(this.engine.getLastState()) as T;
      }
      case 'set_client_size': {
        const cols = (args?.cols as number) || GUEST_DEFAULT_COLS;
        const rows = (args?.rows as number) || GUEST_DEFAULT_ROWS;
        this.engine.send(`refresh-client -C ${cols}x${rows}`);
        return null as T;
      }
      case 'run_tmux_command': {
        const command = args?.command as string | undefined;
        if (!command) return null as T;
        const wire = toControlModeCommand(command);
        // Hot paths (key input, resizes, paste batches) stay fire-and-forget;
        // everything else is tracked so failures reject like the server adapter
        // (surfacing TMUX_ERROR and rolling back optimistic ops). A compound is
        // hot only if EVERY ` ; `-joined segment is — the keyboardActor pins
        // `select-pane -t %N ; <binding>` to every binding, and classifying by
        // prefix alone made a rejected split fire-and-forget: the rejection
        // never surfaced, nothing rolled the placeholder back, and (with no
        // further state emission) the optimistic pane wedged forever.
        const isHot =
          !wire.includes('\n') &&
          wire
            .split(' ; ')
            .every((seg) => /^(send-keys|refresh-client|select-pane|select-window)\b/.test(seg));
        if (wire.includes('\n') || isHot) {
          this.engine.send(wire);
          return null as T;
        }
        const result = await this.engine.sendTracked(wire);
        // Reject the way the real transports do when tmux refuses a command,
        // so it is typed a TmuxError (with tmux's message), not a generic
        // TransportError.
        if (!result.ok) {
          throw {
            error: result.message || `tmux rejected: ${command}`,
            kind: 'tmux',
          } satisfies CommandFailure;
        }
        return null as T;
      }
      case 'set_theme': {
        const name = (args?.name as string) || loadThemeFromStorage()?.theme || 'default';
        saveThemeToStorage(name, parseThemeMode(args?.mode));
        this.engine.send(`set -g @tmuxy-theme ${name}`);
        return null as T;
      }
      case 'set_theme_mode': {
        saveThemeToStorage(loadThemeFromStorage()?.theme || 'default', parseThemeMode(args?.mode));
        return null as T;
      }
      case 'set_cursor_blink': {
        this.engine.send(`set -g @tmuxy-cursor-blink ${args?.enabled ? 'on' : 'off'}`);
        return null as T;
      }
      case 'set_send_ask': {
        this.engine.send(`set -g @tmuxy-send-ask ${args?.enabled ? 'on' : 'off'}`);
        return null as T;
      }
      case 'get_scrollback_cells': {
        const paneId = args?.paneId as string;
        const start = (args?.start as number | undefined) ?? -100;
        const end = (args?.end as number | undefined) ?? -1;
        const state = this.engine.getLastState();
        const pane = state.panes.find((p) => p.tmux_id === paneId);
        const width = pane?.width ?? 80;
        const historySize = pane?.history_size ?? 0;
        const text = await this.engine.captureScrollback(paneId, start, end);
        const cells = this.engine.parseScrollback(text, width);
        return { cells, historySize, start, end, width } as T;
      }
      case 'read_preview':
        return (await readGuestPreview(
          (command) => this.engine.query(command),
          String(args?.paneId ?? ''),
          args?.path as string | undefined,
        )) as T;
      case 'get_theme_settings':
        return (loadThemeFromStorage() || { theme: 'default', mode: 'dark' }) as T;
      case 'get_themes_list':
        return BUNDLED_THEMES as T;
      default:
        // ping / theme / keybindings-snapshot / … — no-op for a guest adapter.
        return null as T;
    }
  }

  /** Read from tmux: the command's output, picked out of the control-mode
   *  stream (empty when tmux refuses it). */
  query(command: string): Promise<string> {
    return this.engine.query(toControlModeCommand(command));
  }

  async switchSession(sessionName: string): Promise<void> {
    // Switch the attached control client to another session (real tmux
    // switch-client), then re-sync so the new session's windows/panes populate.
    // Tracked: a failed switch (unknown session) must NOT leave the app in the
    // cleared-optimistic-state limbo — resync the CURRENT session so its state
    // flows back in (the machine re-adopts panes and sessionName from the
    // updates) and reject so the failure surfaces as TMUX_ERROR.
    const result = await this.engine.sendTracked(`switch-client -t ${sessionName}`);
    this.engine.resync();
    if (!result.ok) {
      throw {
        error: result.message || `switch-client failed: ${sessionName}`,
        kind: 'tmux',
      } satisfies CommandFailure;
    }
  }
}
