/**
 * A fully client-side `TmuxAdapter` backed by REAL tmux.
 *
 * Real tmux 3.7a runs inside a v86 x86 emulator (restored from a pre-booted state
 * snapshot); its `tmux -CC` control-mode stream is parsed by the tmuxy-core Rust
 * engine compiled to WASM — the SAME code the native server runs. No lifo.sh, no
 * DemoTmux simulation, no client-side VT emulator.
 *
 *   TmuxyApp --invoke(run_tmux_command)--> serial0_send --> real tmux -CC
 *     --serial--> tmuxy-wasm (parse + aggregate) --> ServerState --> onStateChange
 *
 * The v86/wasm/serial machinery lives in `V86Engine`. This class is the
 * `TmuxAdapter` facade over it. With `shared: true` many adapters (one per story)
 * reuse a single booted engine — each story restores the pinned snapshot for a
 * clean start (~1s) instead of cold-booting (~5s). Default (`shared` unset) owns
 * a private engine and tears it down on disconnect.
 *
 * Assets are served (Storybook staticDirs / demo public): /v86, /v86-img (kernel,
 * BIOS, tmux-state.bin snapshot), /wasm (tmuxy_wasm). Browser-only.
 */
import type {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  LogListener,
  FatalListener,
  ClipboardListener,
  KeyBindings,
} from '../types';
import { saveThemeToStorage, loadThemeFromStorage } from '../../utils/themeManager';
import { escapeLiteralText, unescapeLiteralText } from '../keyBatching';
import { V86Engine, getSharedEngine } from './V86Engine';

// The default tmuxy keybindings (C-a prefix), intercepted client-side by the
// keyboardActor and dispatched as run_tmux_command — same as the real app.
const DEFAULT_KEYBINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  prefix_bindings: [
    { key: '-', command: 'split-window -v', description: 'Split horizontally' },
    { key: '|', command: 'split-window -h', description: 'Split vertically' },
    { key: '\\', command: 'split-window -h', description: 'Split vertically' },
    { key: '"', command: 'split-window -v', description: 'Split horizontally' },
    { key: '%', command: 'split-window -h', description: 'Split vertically' },
    { key: 'c', command: 'new-window', description: 'New window' },
    { key: 'n', command: 'next-window', description: 'Next window' },
    { key: 'p', command: 'previous-window', description: 'Previous window' },
    { key: 'x', command: 'kill-pane', description: 'Kill pane' },
    { key: '&', command: 'kill-window', description: 'Kill window' },
    { key: 'o', command: 'select-pane -t :.+', description: 'Next pane' },
    { key: 'z', command: 'resize-pane -Z', description: 'Zoom pane' },
    { key: 'Up', command: 'select-pane -U', description: 'Pane above' },
    { key: 'Down', command: 'select-pane -D', description: 'Pane below' },
    { key: 'Left', command: 'select-pane -L', description: 'Pane left' },
    { key: 'Right', command: 'select-pane -R', description: 'Pane right' },
    { key: 'H', command: 'resize-pane -L 5', description: 'Resize left' },
    { key: 'J', command: 'resize-pane -D 5', description: 'Resize down' },
    { key: 'K', command: 'resize-pane -U 5', description: 'Resize up' },
    { key: 'L', command: 'resize-pane -R 5', description: 'Resize right' },
    { key: 'S', command: 'setw synchronize-panes', description: 'Sync panes' },
    { key: '[', command: 'copy-mode', description: 'Enter copy mode' },
    { key: 'Space', command: 'next-layout', description: 'Next layout' },
    { key: '>', command: 'swap-pane -D', description: 'Swap pane down' },
    { key: '<', command: 'swap-pane -U', description: 'Swap pane up' },
    { key: '0', command: 'select-window -t :=0', description: 'Window 0' },
    { key: '1', command: 'select-window -t :=1', description: 'Window 1' },
    { key: '2', command: 'select-window -t :=2', description: 'Window 2' },
  ],
  root_bindings: [
    // Ctrl+hjkl / Ctrl+arrows: group-aware directional pane navigation via the
    // `tmuxy-nav-*` command-aliases (defined at attach by the engine's
    // GUEST_SETUP — the snapshot itself lacks them). Intercepted client-side so
    // C-h isn't sent to the pane as a literal backspace. Same bindings as the
    // real app config (.devcontainer/.tmuxy.defaults.conf).
    { key: 'C-h', command: 'tmuxy-nav-left', description: 'Navigate left' },
    { key: 'C-j', command: 'tmuxy-nav-down', description: 'Navigate down' },
    { key: 'C-k', command: 'tmuxy-nav-up', description: 'Navigate up' },
    { key: 'C-l', command: 'tmuxy-nav-right', description: 'Navigate right' },
    { key: 'C-Left', command: 'tmuxy-nav-left', description: 'Navigate left' },
    { key: 'C-Right', command: 'tmuxy-nav-right', description: 'Navigate right' },
    { key: 'C-Up', command: 'tmuxy-nav-up', description: 'Navigate up' },
    { key: 'C-Down', command: 'tmuxy-nav-down', description: 'Navigate down' },
    { key: 'M-h', command: 'previous-window', description: 'Previous window' },
    { key: 'M-l', command: 'next-window', description: 'Next window' },
    { key: 'M-j', command: 'tmuxy-pane-group-next', description: 'Next pane group' },
    { key: 'M-k', command: 'tmuxy-pane-group-prev', description: 'Prev pane group' },
    { key: 'S-Left', command: 'previous-window', description: 'Previous window' },
    { key: 'S-Right', command: 'next-window', description: 'Next window' },
    { key: 'C-0', command: 'select-window -t 0', description: 'Window 0' },
    { key: 'C-1', command: 'select-window -t 1', description: 'Window 1' },
    { key: 'C-2', command: 'select-window -t 2', description: 'Window 2' },
    { key: 'C-3', command: 'select-window -t 3', description: 'Window 3' },
    { key: 'C-4', command: 'select-window -t 4', description: 'Window 4' },
    { key: 'C-5', command: 'select-window -t 5', description: 'Window 5' },
    { key: 'C-6', command: 'select-window -t 6', description: 'Window 6' },
    { key: 'C-7', command: 'select-window -t 7', description: 'Window 7' },
    { key: 'C-8', command: 'select-window -t 8', description: 'Window 8' },
    { key: 'C-9', command: 'select-window -t 9', description: 'Window 9' },
  ],
};

/** Theme names bundled with tmuxy (mirrors the server's `get_themes_list`). */
const BUNDLED_THEMES: { name: string; displayName: string }[] = [
  { name: 'default', displayName: 'Default' },
  { name: 'cold-harbor', displayName: 'Cold Harbor' },
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
  const literal = line.match(/^(send-keys -t \S+ -l )(.+)$/);
  if (literal) {
    // tmux 3.7a format-expands send-keys arguments, and no amount of `#`
    // doubling protects a valid `#{variable}` (`##{pane_id}` still yields
    // `#%0`). The only reliable transport-level fix: split the literal at every
    // `#`/`{` boundary so the two characters never share a format context —
    // each chunk is its own send-keys and the pane reassembles them verbatim.
    const text = unescapeLiteralText(literal[2]);
    if (!text.includes('#{')) return line;
    const parts = text.split(/(?<=#)(?={)/);
    return parts.map((part) => literal[1] + escapeLiteralText(part)).join('\n');
  }
  if (line.includes(' -l ')) return line;
  return line.replace(/ \\; /g, ' ; ');
}

export interface V86TmuxAdapterOptions {
  /** tmux commands run once after attach (splits, new-window, …). */
  initCommands?: string[];
  /** Reuse a single process-wide v86 engine across adapters (opt-in). Each
   *  connect restores the pinned snapshot for a clean start instead of a cold
   *  boot. Leave unset for a private, torn-down-on-disconnect engine. */
  shared?: boolean;
}

export class V86TmuxAdapter implements TmuxAdapter {
  private readonly engine: V86Engine;
  private readonly shared: boolean;
  private readonly initCommands: string[];
  private connected = false;

  private stateListeners = new Set<StateListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();
  private errorListeners = new Set<ErrorListener>();
  private clipboardListeners = new Set<ClipboardListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private fatalListeners = new Set<FatalListener>();

  constructor(options?: V86TmuxAdapterOptions) {
    this.initCommands = options?.initCommands ?? [];
    this.shared = options?.shared ?? false;
    this.engine = this.shared ? getSharedEngine() : new V86Engine();
  }

  async connect(): Promise<void> {
    // NB: do NOT emit a reconnection signal here. That drives the app machine
    // into its `reconnecting` state, so the subsequent TMUX_CONNECTED is handled
    // by the reconnect branch — which skips the initial theme + keybindings fetch
    // that only the `connecting` branch performs. The app already shows connecting
    // feedback via its own `connecting` state until connect() resolves.
    this.engine.setSink({
      onState: (state) => this.stateListeners.forEach((l) => l(state)),
      onClipboard: (paneId, text) => this.clipboardListeners.forEach((l) => l(paneId, text)),
      onFatal: (message) => this.fatalListeners.forEach((l) => l(message)),
    });

    this.connected = true;
    this.connectionInfoListeners.forEach((l) => l(0, 'bash', true));
    this.keyBindingsListeners.forEach((l) => l(DEFAULT_KEYBINDINGS));

    // Shared + already booted → restore the pinned snapshot for a clean, fast
    // start. Otherwise cold-boot the engine.
    if (this.engine.isBooted()) {
      await this.engine.reset(this.initCommands);
    } else {
      await this.engine.boot(this.initCommands);
    }
  }

  disconnect(): void {
    this.connected = false;
    // Detach our sink so a unmounted story never receives further state.
    this.engine.setSink(null);
    // A private engine is torn down; a shared engine stays alive for reuse.
    if (!this.shared) this.engine.destroy();
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return false;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    switch (cmd) {
      case 'get_initial_state':
        return this.engine.getLastState() as T;
      case 'set_client_size': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        this.engine.send(`refresh-client -C ${cols}x${rows}`);
        return null as T;
      }
      case 'run_tmux_command': {
        const command = args?.command as string | undefined;
        if (command) this.engine.send(toControlModeCommand(command));
        return null as T;
      }
      case 'set_theme': {
        const name = (args?.name as string) || loadThemeFromStorage()?.theme || 'default';
        const mode = (args?.mode as string) === 'light' ? 'light' : 'dark';
        saveThemeToStorage(name, mode);
        this.engine.send(`set -g @tmuxy-theme ${name}`);
        return null as T;
      }
      case 'set_theme_mode': {
        const mode = (args?.mode as string) === 'light' ? 'light' : 'dark';
        saveThemeToStorage(loadThemeFromStorage()?.theme || 'default', mode);
        return null as T;
      }
      case 'get_theme_settings':
        return (loadThemeFromStorage() || { theme: 'default', mode: 'dark' }) as T;
      case 'get_themes_list':
        return BUNDLED_THEMES as T;
      default:
        // ping / theme / keybindings-snapshot / … — no-op for the spike.
        return null as T;
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onConnectionInfo(listener: ConnectionInfoListener): () => void {
    this.connectionInfoListeners.add(listener);
    return () => this.connectionInfoListeners.delete(listener);
  }
  onKeyBindings(listener: KeyBindingsListener): () => void {
    this.keyBindingsListeners.add(listener);
    return () => this.keyBindingsListeners.delete(listener);
  }
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  onReconnection(listener: ReconnectionListener): () => void {
    this.reconnectionListeners.add(listener);
    return () => this.reconnectionListeners.delete(listener);
  }
  onLog(_listener: LogListener): () => void {
    return () => {};
  }
  onFatal(listener: FatalListener): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }
  onClipboard(listener: ClipboardListener): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
  }

  async switchSession(sessionName: string): Promise<void> {
    // Switch the attached control client to another session (real tmux
    // switch-client), then re-sync so the new session's windows/panes populate.
    this.engine.send(`switch-client -t ${sessionName}`);
    this.engine.resync();
  }
}
