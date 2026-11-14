/**
 * A fully client-side `TransportDriver` backed by REAL tmux in an in-browser
 * guest machine; its `tmux -CC` control-mode stream is parsed by the
 * tmuxy-core Rust engine compiled to WASM — the SAME code the native server
 * runs.
 *
 *   TmuxyApp --run(op)--> send(run_tmux_command) --> engine --> real tmux -CC
 *     --guest stream--> tmuxy-wasm (parse + aggregate) --> ServerState --> onStateChange
 *
 * The machine and the wasm core live in a `GuestEngine` (`V86Engine`,
 * `CheerpXEngine`); this class is the driver over one. An
 * adapter that owns its engine tears it down on disconnect; one handed a
 * shared engine leaves it running for the next.
 *
 * Assets are served from the page's origin (Storybook staticDirs / demo
 * public): /wasm (tmuxy_wasm), plus what the engine's machine loads.
 * Browser-only.
 */
import type { TransportDriver } from '../../driver';
import { noAnswer, type BackendCall } from '../../../../domain/backendCalls';
import { EventHub } from '../../../eventHub';
import { TransportEvent } from '../../events';
import { isPaneId } from '../../../../domain/ids';
import { MANAGED_OPTIONS } from '../../../../domain/tmuxyConstants.gen';
import type { CommandFailure } from '../../../../domain/wire';
import { decodeStateForListener } from '../../wireDecode';
import { answerThemeCall, isThemeCall, loadThemePref } from '../../../prefs';
import { DEFAULT_KEYBINDINGS } from './defaultKeybindings';
import { readGuestPreview } from './guestPreview';
import {
  GUEST_DEFAULT_COLS,
  GUEST_DEFAULT_ROWS,
  type EngineSink,
  type GuestEngine,
  type GuestFile,
} from './GuestEngine';

/** A command the routing policy refused, as the native transports refuse it. */
function forbidden(reason: string): CommandFailure {
  return { error: reason, kind: 'forbidden' };
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

export class GuestTmuxAdapter implements TransportDriver {
  readonly answersQueries = true;
  readonly ordersSends = true;
  private readonly initCommands: string[];
  private readonly initDoneOption: string | null;
  private readonly files: Record<string, string | URL>;
  private sink: EngineSink | null = null;

  readonly events = new EventHub<TransportEvent>();

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
    this.events.emit(TransportEvent.ConnectionInfo({ defaultShell: 'bash', hostname: null }));
    this.events.emit(TransportEvent.KeyBindings({ keybindings: DEFAULT_KEYBINDINGS }));

    // The option is cleared first, so a value left by an earlier start does
    // not end the wait at once.
    const done = this.initDoneOption;
    await this.engine.reset(
      done ? [`set -gu ${done}`, ...this.initCommands] : this.initCommands,
      await loadGuestFiles(this.files),
    );
    if (done) await this.engine.waitForOption(done);

    // Installed only after the reset settled: before it, the previous story's
    // core would stream its final states into this adapter (a dead
    // active-window id the new state never contains, so zero panes forever).
    this.sink = {
      onState: (raw) => {
        // A sandbox engine emits a full state every time, so one that fails
        // its decode is simply dropped; the next one replaces it.
        const state = decodeStateForListener(raw);
        if (state) this.events.emit(TransportEvent.State({ state, seq: null }));
      },
      onClipboard: (paneId, text) => {
        const source = paneId !== null && isPaneId(paneId) ? paneId : null;
        this.events.emit(TransportEvent.Clipboard({ paneId: source, text }));
      },
      onMessage: (text) => this.events.emit(TransportEvent.Message({ text })),
      onError: (message) => this.events.emit(TransportEvent.Error({ message })),
      onFatal: (message) => this.events.emit(TransportEvent.Fatal({ message })),
    };
    this.engine.setSink(this.sink);
  }

  disconnect(): void {
    if (this.sink) this.engine.clearSink(this.sink);
    this.sink = null;
    if (this.ownsEngine) this.engine.destroy();
  }

  async send(call: BackendCall): Promise<unknown> {
    if (isThemeCall(call)) {
      const answer = answerThemeCall(call);
      if (call.cmd === 'set_theme')
        this.engine.send(`set -g ${MANAGED_OPTIONS.theme} ${loadThemePref().theme}`);
      return answer;
    }
    switch (call.cmd) {
      case 'get_initial_state': {
        // Sized to the client's viewport first, as the native server does, so
        // the first frame is drawn at the size it stays at.
        const { cols, rows } = call.args;
        if (cols > 0 && rows > 0) await this.engine.resize(cols, rows);
        return this.engine.getLastState();
      }
      case 'set_client_size':
        this.engine.setClientSize(
          call.args.cols || GUEST_DEFAULT_COLS,
          call.args.rows || GUEST_DEFAULT_ROWS,
        );
        return null;
      case 'run_tmux_command':
        await this.runCommand(call.args.command);
        return null;
      case 'query_tmux':
        return this.query(call.args.command);
      case 'set_cursor_blink':
        this.engine.send(
          `set -g ${MANAGED_OPTIONS.cursorBlink} ${call.args.enabled ? 'on' : 'off'}`,
        );
        return null;
      case 'set_send_ask':
        this.engine.send(`set -g ${MANAGED_OPTIONS.sendAsk} ${call.args.enabled ? 'on' : 'off'}`);
        return null;
      case 'get_scrollback_cells': {
        const { paneId, start, end } = call.args;
        const pane = this.engine.getLastState().panes.find((p) => p.tmux_id === paneId);
        if (!pane) {
          throw { error: `can't find pane: ${paneId}`, kind: 'tmux' } satisfies CommandFailure;
        }
        const { width, history_size: historySize } = pane;
        const text = await this.engine.captureScrollback(paneId, start, end);
        const cells = this.engine.parseScrollback(text, width);
        return { cells, historySize, start, end, width };
      }
      // The guest's tmux is not walked for prompt marks: a pane here has
      // none, and no last output to copy (docs/PROMPT-MARKS.md).
      case 'get_prompt_marks':
        return { historySize: 0, prompts: [] };
      case 'get_last_command_output':
        return { text: null };
      case 'read_preview':
        return readGuestPreview(
          (command) => this.engine.query(command),
          call.args.paneId,
          call.args.path ?? undefined,
        );
      default:
        return noAnswer(call.cmd);
    }
  }

  private async runCommand(command: string): Promise<void> {
    if (!command) return;
    const route = this.engine.route(command, 'command');
    if ('blocked' in route) throw forbidden(route.blocked);
    const wire = route.routed;
    // Keystrokes are the hot path over the guest's slow serial line: a list
    // the core reports no failure of (one that types keys) is sent without a
    // reply to wait for. Any other list is awaited, so a refusal rejects as a
    // TmuxError and the store rolls its prediction back.
    if (!this.engine.reportsFailure(wire)) {
      this.engine.run(wire);
      return;
    }
    const reply = await this.engine.ask(wire);
    // Typed a TmuxError, as the native transports reject a refusal.
    if (reply.error !== null) {
      throw {
        error: reply.error || `tmux rejected: ${command}`,
        kind: 'tmux',
      } satisfies CommandFailure;
    }
  }

  private async query(command: string): Promise<string> {
    const route = this.engine.route(command, 'query');
    if ('blocked' in route) throw forbidden(route.blocked);
    const reply = await this.engine.ask(route.routed);
    if (reply.error !== null) throw { error: reply.error, kind: 'tmux' } satisfies CommandFailure;
    return reply.output;
  }

  async switchSession(sessionName: string): Promise<void> {
    // The engine re-syncs either way, so a failed switch flows the current
    // session's state back in rather than leaving the app with its optimistic
    // state cleared.
    const reply = await this.engine.switchSession(sessionName);
    if (reply.error !== null) {
      throw {
        error: reply.error || `switch-client failed: ${sessionName}`,
        kind: 'tmux',
      } satisfies CommandFailure;
    }
  }
}
