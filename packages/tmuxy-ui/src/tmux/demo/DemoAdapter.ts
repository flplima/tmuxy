import type {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  KeyBindings,
} from '../types';
import { DemoTmux } from './DemoTmux';

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
    { key: 'r', command: 'source-file ~/.tmuxy.conf', description: 'Reload config' },
    { key: 'S', command: 'setw synchronize-panes', description: 'Sync panes' },
    { key: '=', command: 'tmuxy-pane-group-add', description: 'Add to pane group' },
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
    { key: 'C-h', command: 'tmuxy-nav left', description: 'Navigate left' },
    { key: 'C-j', command: 'tmuxy-nav down', description: 'Navigate down' },
    { key: 'C-k', command: 'tmuxy-nav up', description: 'Navigate up' },
    { key: 'C-l', command: 'tmuxy-nav right', description: 'Navigate right' },
    { key: 'C-Left', command: 'tmuxy-nav left', description: 'Navigate left' },
    { key: 'C-Right', command: 'tmuxy-nav right', description: 'Navigate right' },
    { key: 'C-Up', command: 'tmuxy-nav up', description: 'Navigate up' },
    { key: 'C-Down', command: 'tmuxy-nav down', description: 'Navigate down' },
    { key: 'M-h', command: 'previous-window', description: 'Previous window' },
    { key: 'M-l', command: 'next-window', description: 'Next window' },
    { key: 'M-j', command: 'tmuxy-pane-group-next', description: 'Next pane group' },
    { key: 'M-k', command: 'tmuxy-pane-group-prev', description: 'Prev pane group' },
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
  ],
};

export interface DemoAdapterOptions {
  /** Tmux commands to run after initial state is loaded (e.g. split-window, new-window) */
  initCommands?: string[];
}

export class DemoAdapter implements TmuxAdapter {
  private connected = false;
  private tmux: DemoTmux;
  private initCommands: string[];

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();

  constructor(options?: DemoAdapterOptions) {
    this.tmux = new DemoTmux();
    this.initCommands = options?.initCommands ?? [];
  }

  async connect(): Promise<void> {
    this.tmux.init(80, 24);
    this.connected = true;

    // Notify connection info
    this.connectionInfoListeners.forEach((l) => l(0, 'bash'));

    // Emit keybindings
    this.keyBindingsListeners.forEach((l) => l(DEFAULT_KEYBINDINGS));
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return false;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    switch (cmd) {
      case 'get_initial_state': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        this.tmux.setSize(cols, rows);
        // Run init commands (splits, new windows, etc.) before returning state
        for (const initCmd of this.initCommands) {
          this.executeCommand(initCmd);
        }
        this.initCommands = []; // Only run once
        return this.tmux.getState() as T;
      }

      case 'set_client_size': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        this.tmux.setSize(cols, rows);
        this.emitState();
        return null as T;
      }

      case 'run_tmux_command': {
        const command = args?.command as string;
        if (command) this.handleTmuxCommand(command);
        return null as T;
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

      case 'get_key_bindings':
        return DEFAULT_KEYBINDINGS as T;

      case 'ping':
        return null as T;

      case 'initialize_session':
        return null as T;

      case 'set_theme':
      case 'set_theme_mode':
        return null as T;

      case 'get_theme_settings':
        return { theme: 'default', mode: 'dark' } as T;

      case 'get_themes_list':
        return [
          { name: 'default', displayName: 'Default' },
          { name: 'dracula', displayName: 'Dracula' },
          { name: 'gruvbox', displayName: 'Gruvbox' },
          { name: 'nord', displayName: 'Nord' },
          { name: 'solarized', displayName: 'Solarized' },
          { name: 'tokyonight', displayName: 'Tokyo Night' },
        ] as T;

      default:
        return null as T;
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onConnectionInfo(listener: ConnectionInfoListener): () => void {
    this.connectionInfoListeners.add(listener);
    return () => this.connectionInfoListeners.delete(listener);
  }

  onReconnection(listener: ReconnectionListener): () => void {
    this.reconnectionListeners.add(listener);
    return () => this.reconnectionListeners.delete(listener);
  }

  onKeyBindings(listener: KeyBindingsListener): () => void {
    this.keyBindingsListeners.add(listener);
    return () => this.keyBindingsListeners.delete(listener);
  }

  private emitState(): void {
    const state = this.tmux.getState();
    this.stateListeners.forEach((l) => l(state));
  }

  private handleTmuxCommand(commandStr: string): void {
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
    if (!command) return;

    // Parse tmux command
    const parts = this.parseTmuxCommand(command);
    if (parts.length === 0) return;

    const cmd = parts[0];

    switch (cmd) {
      case 'send-keys': {
        this.handleSendKeys(parts.slice(1));
        break;
      }

      case 'split-window':
      case 'splitw': {
        const isVertical = parts.includes('-h');
        this.tmux.splitPane(isVertical ? 'vertical' : 'horizontal');
        break;
      }

      case 'new-window':
      case 'neww': {
        this.tmux.newWindow();
        break;
      }

      case 'select-window':
      case 'selectw': {
        const tIdx = parts.indexOf('-t');
        if (tIdx !== -1 && tIdx + 1 < parts.length) {
          const target = parts[tIdx + 1];
          // Parse ":=N" format
          const match = target.match(/:=?(\d+)$/);
          if (match) {
            this.tmux.selectWindow(match[1]);
          } else {
            this.tmux.selectWindow(target);
          }
        }
        break;
      }

      case 'next-window':
      case 'next':
        this.tmux.nextWindow();
        break;

      case 'previous-window':
      case 'prev':
        this.tmux.previousWindow();
        break;

      case 'select-pane':
      case 'selectp': {
        const tIdx = parts.indexOf('-t');
        if (tIdx !== -1 && tIdx + 1 < parts.length) {
          const target = parts[tIdx + 1];
          if (target === ':.+') {
            // Next pane - select first pane that isn't active
            const state = this.tmux.getState();
            const currentIdx = state.panes.findIndex((p) => p.tmux_id === state.active_pane_id);
            if (state.panes.length > 1) {
              const nextIdx = (currentIdx + 1) % state.panes.length;
              this.tmux.selectPane(state.panes[nextIdx].tmux_id);
            }
          } else {
            this.tmux.selectPane(target);
          }
        }
        // Direction flags
        if (parts.includes('-U')) this.tmux.selectPaneByDirection('Up');
        if (parts.includes('-D')) this.tmux.selectPaneByDirection('Down');
        if (parts.includes('-L')) this.tmux.selectPaneByDirection('Left');
        if (parts.includes('-R')) this.tmux.selectPaneByDirection('Right');
        break;
      }

      case 'kill-pane':
      case 'killp': {
        const tIdx = parts.indexOf('-t');
        if (tIdx !== -1 && tIdx + 1 < parts.length) {
          this.tmux.killPane(parts[tIdx + 1]);
        } else {
          this.tmux.killPane();
        }
        break;
      }

      case 'kill-window':
      case 'killw': {
        const tIdx = parts.indexOf('-t');
        if (tIdx !== -1 && tIdx + 1 < parts.length) {
          this.tmux.killWindow(parts[tIdx + 1]);
        } else {
          this.tmux.killWindow();
        }
        break;
      }

      case 'resize-pane':
      case 'resizep': {
        const state = this.tmux.getState();
        const paneId = state.active_pane_id ?? '';
        const adjustment = parseInt(parts[parts.length - 1]) || 1;
        if (parts.includes('-Z')) {
          this.tmux.toggleZoom();
        } else if (parts.includes('-U')) {
          this.tmux.resizePane(paneId, 'Up', adjustment);
        } else if (parts.includes('-D')) {
          this.tmux.resizePane(paneId, 'Down', adjustment);
        } else if (parts.includes('-L')) {
          this.tmux.resizePane(paneId, 'Left', adjustment);
        } else if (parts.includes('-R')) {
          this.tmux.resizePane(paneId, 'Right', adjustment);
        }
        break;
      }

      case 'rename-window':
      case 'renamew': {
        // rename-window -- 'name'
        const dashIdx = parts.indexOf('--');
        if (dashIdx !== -1 && dashIdx + 1 < parts.length) {
          const name = parts[dashIdx + 1].replace(/^'|'$/g, '');
          const state = this.tmux.getState();
          if (state.active_window_id) {
            this.tmux.renameWindow(state.active_window_id, name);
          }
        }
        break;
      }

      case 'next-layout':
        this.tmux.nextLayout();
        break;

      case 'swap-pane':
      case 'swapp': {
        let src = '';
        let dst = '';
        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === '-s' && i + 1 < parts.length) {
            src = parts[++i];
          } else if (parts[i] === '-t' && i + 1 < parts.length) {
            dst = parts[++i];
          } else if (parts[i] === '-U') {
            // swap up - swap with previous pane
            const state = this.tmux.getState();
            const idx = state.panes.findIndex((p) => p.tmux_id === state.active_pane_id);
            if (idx > 0)
              this.tmux.swapPanes(state.panes[idx].tmux_id, state.panes[idx - 1].tmux_id);
          } else if (parts[i] === '-D') {
            const state = this.tmux.getState();
            const idx = state.panes.findIndex((p) => p.tmux_id === state.active_pane_id);
            if (idx >= 0 && idx < state.panes.length - 1)
              this.tmux.swapPanes(state.panes[idx].tmux_id, state.panes[idx + 1].tmux_id);
          }
        }
        if (src && dst) this.tmux.swapPanes(src, dst);
        break;
      }

      case 'break-pane':
      case 'breakp':
        this.tmux.breakPane();
        break;

      case 'tmuxy-pane-group-add':
        this.tmux.groupAdd();
        break;

      case 'tmuxy-pane-group-next':
        this.tmux.groupNext();
        break;

      case 'tmuxy-pane-group-prev':
        this.tmux.groupPrev();
        break;

      case 'tmuxy-nav': {
        const dir = parts[1];
        if (dir === 'left' || dir === 'right') {
          this.tmux.navHorizontal(dir);
        } else if (dir === 'up' || dir === 'down') {
          this.tmux.navVertical(dir);
        }
        break;
      }

      case 'run-shell': {
        // Handle pane-group scripts; ignore everything else
        const cmdStr = parts.join(' ');
        if (cmdStr.includes('pane-group-add')) {
          this.tmux.groupAdd();
        } else if (cmdStr.includes('pane-group-switch')) {
          const paneMatch = cmdStr.match(/%\d+/);
          if (paneMatch) this.tmux.groupSwitch(paneMatch[0]);
        } else if (cmdStr.includes('pane-group-close')) {
          const paneMatch = cmdStr.match(/%\d+/);
          const targetId = paneMatch ? paneMatch[0] : undefined;
          // groupClose handles grouped panes; falls back to killPane for ungrouped
          if (!this.tmux.groupClose(targetId)) {
            this.tmux.killPane(targetId);
          }
        }
        break;
      }

      case 'copy-mode':
      case 'resize-window':
        // Not supported in demo mode - silently ignore
        break;

      default:
        break;
    }
  }

  private handleSendKeys(args: string[]): void {
    let literal = false;
    let targetPaneId: string | null = null;
    const keys: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l') {
        literal = true;
      } else if (args[i] === '-t') {
        i++; // skip target (session name)
      } else if (args[i] === '-X') {
        // Copy mode command - ignore in demo
        return;
      } else {
        keys.push(args[i]);
      }
    }

    // Check if a pane ID was specified in target
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t' && i + 1 < args.length) {
        const target = args[i + 1];
        if (target.startsWith('%')) {
          targetPaneId = target;
        }
      }
    }

    if (literal) {
      // Literal text - join all remaining args
      const text = keys.join(' ');
      // Unescape single quotes: '\'' → '
      const unescaped = text.replace(/^'|'$/g, '').replace(/'\\'''/g, "'");
      if (targetPaneId) {
        for (const ch of unescaped) {
          this.tmux.sendKeyToPane(targetPaneId, ch);
        }
      } else {
        this.tmux.sendLiteral(unescaped);
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

  private parseTmuxCommand(command: string): string[] {
    // Simple command parser that handles quoted strings
    const parts: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];

      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        // Check for \' escape sequence
        if (i + 1 < command.length && command[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        escaped = true;
        continue;
      }

      if (inSingle) {
        if (ch === "'") inSingle = false;
        else current += ch;
      } else if (inDouble) {
        if (ch === '"') inDouble = false;
        else current += ch;
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === ' ' || ch === '\t') {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }
}
