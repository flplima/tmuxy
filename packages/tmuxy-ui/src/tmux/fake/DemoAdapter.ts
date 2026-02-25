import type {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  KeyBindings,
} from '../types';
import { FakeTmux } from './fakeTmux';

const DEFAULT_KEYBINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  prefix_bindings: [
    { key: '"', command: 'split-window', description: 'Split horizontally' },
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
  root_bindings: [],
};

export class DemoAdapter implements TmuxAdapter {
  private connected = false;
  private tmux: FakeTmux;

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();

  constructor() {
    this.tmux = new FakeTmux();
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
        const cells = this.tmux.getScrollbackCells(paneId);
        return {
          cells,
          historySize: 0,
          start: 0,
          end: cells.length,
          width: 80,
        } as T;
      }

      case 'get_key_bindings':
        return DEFAULT_KEYBINDINGS as T;

      case 'ping':
        return null as T;

      case 'initialize_session':
        return null as T;

      default:
        console.warn(`[DemoAdapter] Unhandled command: ${cmd}`);
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
          // Zoom toggle - not supported in demo, ignore
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

      case 'copy-mode':
      case 'resize-window':
      case 'swap-pane':
      case 'run-shell':
        // Not supported in demo mode - silently ignore
        break;

      default:
        console.warn(`[DemoAdapter] Unhandled tmux command: ${cmd}`);
        break;
    }

    this.emitState();
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
