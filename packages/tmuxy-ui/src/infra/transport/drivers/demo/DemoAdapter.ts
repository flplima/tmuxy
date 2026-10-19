import type { TmuxAdapter } from '../../driver';
import { EventHub } from '../../../eventHub';
import { TransportEvent } from '../../events';
import type { PaneId } from '../../../../domain/ids';
import type { CommandFailure, KeyBindings } from '../../../../domain/wire';
import { decodeServerStateOrThrow, decodeStateForListener } from '../../wireDecode';
import type { TraceSettings } from '../../../../machines/types/domain';
import { DemoTmux } from './DemoTmux';
import { executeDemoCommand } from './demoCommandExec';
import { STICKY_TABLE_ENTRIES, STICKY_TABLES } from '../stickyTables';
import {
  saveThemeToStorage,
  loadThemeFromStorage,
  parseThemeMode,
} from '../../../../utils/themeManager';

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
    ...STICKY_TABLE_ENTRIES,
    { key: 'x', command: 'kill-pane', description: 'Kill pane' },
    { key: '&', command: 'kill-window', description: 'Kill window' },
    { key: 'o', command: 'select-pane -t :.+', description: 'Next pane' },
    { key: 'z', command: 'resize-pane -Z', description: 'Zoom pane' },
    {
      key: ',',
      command: 'command-prompt -I "#W" "rename-window -- \'%%\'"',
      description: 'Rename window',
    },
    { key: 'Up', command: 'select-pane -U', description: 'Pane above' },
    { key: 'Down', command: 'select-pane -D', description: 'Pane below' },
    { key: 'Left', command: 'select-pane -L', description: 'Pane left' },
    { key: 'Right', command: 'select-pane -R', description: 'Pane right' },
    { key: 'H', command: 'resize-pane -L 5', description: 'Resize left' },
    { key: 'J', command: 'resize-pane -D 5', description: 'Resize down' },
    { key: 'K', command: 'resize-pane -U 5', description: 'Resize up' },
    { key: 'L', command: 'resize-pane -R 5', description: 'Resize right' },
    { key: '=', command: 'tmuxy-pane-group-add', description: 'Add to pane group' },
    { key: '[', command: 'copy-mode -t demo', description: 'Enter copy mode' },
    { key: 'Space', command: 'next-layout', description: 'Next layout' },
    { key: '>', command: 'swap-pane -D', description: 'Swap pane down' },
    { key: '<', command: 'swap-pane -U', description: 'Swap pane up' },
    { key: '0', command: 'select-window -t :=0', description: 'Window 0' },
    { key: '1', command: 'select-window -t :=1', description: 'Window 1' },
    { key: '2', command: 'select-window -t :=2', description: 'Window 2' },
    { key: '3', command: 'select-window -t :=3', description: 'Window 3' },
    { key: '4', command: 'select-window -t :=4', description: 'Window 4' },
    { key: '5', command: 'select-window -t :=5', description: 'Window 5' },
    { key: '6', command: 'select-window -t :=6', description: 'Window 6' },
    { key: '7', command: 'select-window -t :=7', description: 'Window 7' },
    { key: '8', command: 'select-window -t :=8', description: 'Window 8' },
    { key: '9', command: 'select-window -t :=9', description: 'Window 9' },
  ],
  root_bindings: [
    // Pane nav on Ctrl+hjkl. Mirrors .devcontainer/.tmuxy.defaults.conf.
    { key: 'C-h', command: 'tmuxy-nav left', description: 'Navigate left' },
    { key: 'C-j', command: 'tmuxy-nav down', description: 'Navigate down' },
    { key: 'C-k', command: 'tmuxy-nav up', description: 'Navigate up' },
    { key: 'C-l', command: 'tmuxy-nav right', description: 'Navigate right' },
    { key: 'C-Left', command: 'tmuxy-nav left', description: 'Navigate left' },
    { key: 'C-Right', command: 'tmuxy-nav right', description: 'Navigate right' },
    { key: 'C-Up', command: 'tmuxy-nav up', description: 'Navigate up' },
    { key: 'C-Down', command: 'tmuxy-nav down', description: 'Navigate down' },
    { key: 'C-Tab', command: 'next-window', description: 'Next window' },
    { key: 'C-S-Tab', command: 'previous-window', description: 'Previous window' },
    { key: 'M-1', command: 'select-window -t 1', description: 'Window 1' },
    { key: 'M-2', command: 'select-window -t 2', description: 'Window 2' },
    { key: 'M-3', command: 'select-window -t 3', description: 'Window 3' },
    { key: 'M-4', command: 'select-window -t 4', description: 'Window 4' },
    { key: 'M-5', command: 'select-window -t 5', description: 'Window 5' },
    { key: 'M-6', command: 'select-window -t 6', description: 'Window 6' },
    { key: 'M-7', command: 'select-window -t 7', description: 'Window 7' },
    { key: 'M-8', command: 'select-window -t 8', description: 'Window 8' },
    { key: 'M-9', command: 'select-window -t 9', description: 'Window 9' },
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
  tables: STICKY_TABLES,
};

export interface DemoAdapterOptions {
  /** Tmux commands to run after initial state is loaded (e.g. split-window, new-window) */
  initCommands?: string[];
  /**
   * Artificial delay (ms) applied to every `run_tmux_command` invocation
   * before the command runs and state is emitted. Used by storybook stories
   * to verify optimistic-update UI behaves smoothly during slow backends.
   * Defaults to 0 (synchronous).
   */
  commandDelayMs?: number;
  /**
   * Callback consulted before each `run_tmux_command` invocation. Returning a
   * string causes the promise to reject with `{ error: <string>, kind: 'tmux' }`
   * — what a real transport rejects with when tmux refuses a command — which
   * `classifyAdapterError` types as a TmuxError carrying that stderr. Returning false /
   * null / undefined lets the command run normally. Used by stories to assert
   * the UI rolls back optimistic state on tmux rejections.
   */
  failCommand?: (command: string) => string | false | null | undefined;
}

export class DemoAdapter implements TmuxAdapter {
  private tmux: DemoTmux;
  private initCommands: string[];
  /** Copy of initCommands saved to re-run if set_client_size fires with different dims */
  private savedInitCommands: string[];
  /** Cols/rows used during get_initial_state — compared against first set_client_size */
  private initCols = 0;
  private initRows = 0;
  /** True after the first set_client_size has been handled (no further reinit) */
  private firstSizeHandled = false;
  /**
   * In-memory stand-in for the backend's trace switch. The demo writes no
   * file — it exists so the Debug menu renders and reacts like the real one.
   */
  private traceSettings: TraceSettings = {
    enabled: false,
    level: 'shape',
    // A path inside the demo's own simulated home, so "copy path" hands back
    // something consistent with the rest of the demo filesystem.
    path: '/home/demo/.local/state/tmuxy/trace.ndjson',
    locked: false,
  };

  readonly events = new EventHub<TransportEvent>();
  private commandDelayMs: number;
  private failCommand: DemoAdapterOptions['failCommand'];

  constructor(options?: DemoAdapterOptions) {
    this.tmux = new DemoTmux();
    this.tmux.setOnAsyncUpdate(() => this.emitState());
    this.initCommands = options?.initCommands ?? [];
    this.savedInitCommands = [...this.initCommands];
    this.commandDelayMs = options?.commandDelayMs ?? 0;
    this.failCommand = options?.failCommand;
  }

  /**
   * Storybook/test escape hatch — push an OSC 52 clipboard write to
   * subscribers without going through the demo shell. Mirrors what the real
   * Rust backend does when an app like `printf '\e]52;c;…\e\\' …` runs in a
   * tmuxy pane. Used by ClipboardOSC52 stories so the test doesn't need a
   * live tmux process.
   */
  public emitClipboard(paneId: PaneId, text: string): void {
    this.events.emit(TransportEvent.Clipboard({ paneId, text }));
  }

  /**
   * Storybook/test escape hatch — re-emit the current state snapshot to
   * subscribers, as if the backend sent an unsolicited update. Lets stories
   * drive the store's reconcile pass at a chosen moment (e.g. while a delayed
   * command is still in flight, to exercise the stale-op sweeper).
   */
  public emitStateSnapshot(): void {
    this.emitState();
  }

  async connect(): Promise<void> {
    this.tmux.init(80, 24);

    this.events.emit(TransportEvent.ConnectionInfo({ defaultShell: 'bash', readOnly: false }));
    this.events.emit(TransportEvent.KeyBindings({ keybindings: DEFAULT_KEYBINDINGS }));
  }

  disconnect(): void {}

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    switch (cmd) {
      case 'get_initial_state': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        this.initCols = cols;
        this.initRows = rows;
        this.tmux.setSize(cols, rows);
        // Run init commands (splits, new windows, etc.) before returning state
        for (const initCmd of this.initCommands) {
          this.executeCommand(initCmd);
        }
        this.initCommands = []; // Only run once
        return decodeServerStateOrThrow(this.tmux.getState()) as T;
      }

      case 'get_scrollback_cells': {
        const paneId = args?.paneId as string;
        const start = args?.start as number | undefined;
        const end = args?.end as number | undefined;
        const cells = this.tmux.getScrollbackCells(paneId, start, end);
        const state = this.tmux.getState();
        const pane = state.panes.find((p) => p.tmux_id === paneId);
        return {
          cells,
          historySize: pane?.history_size ?? 0,
          start: start ?? 0,
          end: end ?? cells.length,
          width: pane?.width ?? 80,
        } as T;
      }

      case 'set_client_size': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        // On the first set_client_size, if dimensions differ from what was used during
        // get_initial_state (which used window.innerWidth as fallback before the container
        // was measured), re-initialize DemoTmux with the correct container dimensions so
        // group pane content is rendered at the right width.
        if (!this.firstSizeHandled && this.savedInitCommands.length > 0) {
          this.firstSizeHandled = true;
          if (cols !== this.initCols || rows !== this.initRows) {
            this.tmux = new DemoTmux();
            this.tmux.setOnAsyncUpdate(() => this.emitState());
            this.tmux.init(cols, rows);
            for (const cmd of this.savedInitCommands) {
              this.executeCommand(cmd);
            }
          } else {
            this.tmux.setSize(cols, rows);
          }
        } else {
          this.tmux.setSize(cols, rows);
        }
        this.emitState();
        return null as T;
      }

      case 'run_tmux_command': {
        const command = args?.command as string;
        if (!command) return null as T;
        if (this.initCommands.length > 0) {
          for (const initCmd of this.initCommands) {
            this.executeCommand(initCmd);
          }
          this.initCommands = [];
        }
        this.firstSizeHandled = true;
        if (this.failCommand) {
          const reason = this.failCommand(command);
          if (typeof reason === 'string') {
            if (this.commandDelayMs > 0) {
              await new Promise<void>((r) => setTimeout(r, this.commandDelayMs));
            }
            // The real transports' shape for a command tmux refused.
            throw { error: reason, kind: 'tmux' } satisfies CommandFailure;
          }
        }
        if (this.commandDelayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, this.commandDelayMs));
        }
        this.handleTmuxCommand(command);
        return null as T;
      }

      case 'ping':
        return null as T;

      case 'initialize_session':
        return null as T;

      case 'set_theme': {
        const name = args?.name as string | undefined;
        const mode = args?.mode as string | undefined;
        const saved = loadThemeFromStorage();
        saveThemeToStorage(
          name || saved?.theme || 'default',
          mode === undefined ? (saved?.mode ?? 'dark') : parseThemeMode(mode),
        );
        return null as T;
      }
      case 'set_theme_mode': {
        const prev = loadThemeFromStorage();
        saveThemeToStorage(prev?.theme || 'default', parseThemeMode(args?.mode));
        return null as T;
      }

      // The demo has no config to write to, so these switches live only in the
      // machine's context for as long as the page is open.
      case 'set_cursor_blink':
      case 'set_send_ask':
        return null as T;

      case 'get_theme_settings': {
        const stored = loadThemeFromStorage();
        return (stored || { theme: 'default', mode: 'dark' }) as T;
      }

      case 'get_themes_list':
        return [
          { name: 'default', displayName: 'Default' },
          { name: 'cold-harbor', displayName: 'Cold Harbor' },
          { name: 'dracula', displayName: 'Dracula' },
          { name: 'fallout', displayName: 'Fallout' },
          { name: 'gruvbox', displayName: 'Gruvbox' },
          { name: 'nord', displayName: 'Nord' },
          { name: 'solarized', displayName: 'Solarized' },
          { name: 'tokyonight', displayName: 'Tokyo Night' },
        ] as T;

      // Local action tracing (docs/TRACING.md). The demo has no backend to
      // write an NDJSON file, so it models the switch in memory: the Debug
      // menu is fully explorable, and nothing is ever recorded.
      case 'get_trace_settings':
        return { ...this.traceSettings } as T;

      case 'set_trace_enabled':
        this.traceSettings.enabled = Boolean(args?.enabled);
        return this.traceSettings.enabled as T;

      case 'set_trace_level': {
        const level = args?.level;
        this.traceSettings.level = level === 'labeled' || level === 'full' ? level : 'shape';
        return this.traceSettings.level as T;
      }

      default:
        return null as T;
    }
  }

  private emitState(): void {
    const state = decodeStateForListener(this.tmux.getState());
    if (state) this.events.emit(TransportEvent.State({ state, seq: null }));
  }

  private handleTmuxCommand(commandStr: string): void {
    // write-widget takes multi-line content as its last argument, so it must
    // be detected BEFORE the newline split — otherwise a runtime widget was
    // shredded into garbage commands. (It only ever worked because the demo
    // site passes multi-line widgets through initCommands, which bypasses
    // this path.)
    if (/^\s*write-widget\s/.test(commandStr)) {
      this.handleSingleCommand(commandStr.trim());
      return;
    }
    // Handle multi-line commands (from paste)
    const commands = commandStr.split('\n');
    for (const cmd of commands) {
      this.handleSingleCommand(cmd.trim());
    }
  }

  private handleSingleCommand(command: string): void {
    this.executeCommand(command);
    this.emitState();
  }

  /** Execute a tmux command without emitting state (used for batched init) */
  private executeCommand(command: string): void {
    executeDemoCommand(
      this.tmux,
      command,
      () => this.emitState(),
      (args) => this.handleSendKeys(args),
    );
  }

  private handleSendKeys(args: string[]): void {
    let literal = false;
    let targetPaneId: string | null = null;
    const keys: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l') {
        literal = true;
      } else if (args[i] === '--') {
        // End of options: everything after is the text, dashes and all.
        keys.push(...args.slice(i + 1));
        break;
      } else if (args[i] === '-t') {
        i++;
        if (i < args.length && args[i].startsWith('%')) {
          targetPaneId = args[i];
        }
      } else if (args[i] === '-X') {
        // Copy mode command. The demo emulates copy mode minimally: commands
        // that leave copy mode (cancel, copy-selection-and-cancel) exit it; the
        // rest (scroll/selection/cursor motion) are accepted but not visually
        // emulated, since the demo has no live tmux to capture a scrolled view.
        const copyCmd = args.slice(i + 1).join(' ');
        if (copyCmd === 'cancel' || copyCmd.startsWith('copy-selection-and-cancel')) {
          const paneId =
            targetPaneId ?? (this.tmux.getState() as { active_pane_id: string }).active_pane_id;
          if (paneId) {
            this.tmux.exitCopyMode(paneId);
            this.emitState();
          }
        }
        return;
      } else {
        keys.push(args[i]);
      }
    }

    if (literal) {
      // Literal text - join all remaining args.
      //
      // parseTmuxCommand has ALREADY stripped the surrounding quotes and
      // resolved `'\''` escapes, so no further unescaping belongs here. The
      // previous `.replace(/^'|'$/g, '')` stripped genuine leading/trailing
      // quotes from the payload — pasting `'quoted'` typed `quoted` — and the
      // `'\''` replace could never match post-parse text.
      const text = keys.join(' ');
      if (targetPaneId) {
        for (const ch of text) {
          this.tmux.sendKeyToPane(targetPaneId, ch);
        }
      } else {
        this.tmux.sendLiteral(text);
      }
    } else {
      // Key names
      for (const key of keys) {
        if (targetPaneId) {
          this.tmux.sendKeyToPane(targetPaneId, key);
        } else {
          this.tmux.sendKey(key);
        }
      }
    }
  }
}
