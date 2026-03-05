import type {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  KeyBindings,
  ServerState,
  ServerPane,
  ServerWindow,
} from './types';
import { VtEmulator } from './VtEmulator';
import { unescapeLiteralText } from './keyBatching';
import { saveThemeToStorage, loadThemeFromStorage } from '../utils/themeManager';

// ── Types for @wasmer/sdk (loaded dynamically from CDN) ──────────────────────

interface WasmerInstance {
  stdin?: { getWriter(): WritableStreamDefaultWriter<Uint8Array> };
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
}

interface WasmerPackage {
  entrypoint: { run(): Promise<WasmerInstance> };
  commands: Record<string, unknown>;
}

interface WasmerSDK {
  init(): Promise<void>;
  Wasmer: { fromRegistry(name: string): Promise<WasmerPackage> };
}

// ── Key bindings ─────────────────────────────────────────────────────────────

const WASM_KEYBINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  prefix_bindings: [],
  root_bindings: [],
};

// ── Key name → stdin bytes mapping ───────────────────────────────────────────

const KEY_MAP: Record<string, string> = {
  Enter: '\r',
  Return: '\r',
  BackSpace: '\x7f',
  BSpace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  Space: ' ',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',
  'C-a': '\x01',
  'C-b': '\x02',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-e': '\x05',
  'C-f': '\x06',
  'C-g': '\x07',
  'C-h': '\x08',
  'C-i': '\x09',
  'C-j': '\x0a',
  'C-k': '\x0b',
  'C-l': '\x0c',
  'C-m': '\x0d',
  'C-n': '\x0e',
  'C-o': '\x0f',
  'C-p': '\x10',
  'C-q': '\x11',
  'C-r': '\x12',
  'C-s': '\x13',
  'C-t': '\x14',
  'C-u': '\x15',
  'C-v': '\x16',
  'C-w': '\x17',
  'C-x': '\x18',
  'C-y': '\x19',
  'C-z': '\x1a',
  'M-b': '\x1bb',
  'M-f': '\x1bf',
  'M-d': '\x1bd',
  'M-BackSpace': '\x1b\x7f',
};

// ── WasmAdapter ───────────────────────────────────────────────────────────────

/**
 * TmuxAdapter implementation backed by bash.wasm via @wasmer/sdk.
 * Activated when the URL contains the `?wasm` query parameter.
 *
 * Provides a single-pane bash session running entirely in the browser.
 * Terminal output is parsed by VtEmulator and emitted as structured
 * PaneContent updates.
 *
 * Requires COOP/COEP headers for SharedArrayBuffer support.
 */
export class WasmAdapter implements TmuxAdapter {
  private connected = false;
  private emulator: VtEmulator;
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();

  private cols = 80;
  private rows = 24;

  constructor() {
    this.emulator = new VtEmulator(this.cols, this.rows);
  }

  async connect(): Promise<void> {
    try {
      const sdkUrl = 'https://unpkg.com/@wasmer/sdk@0.10.0/dist/index.mjs';
      const sdk: WasmerSDK = await import(/* @vite-ignore */ sdkUrl);

      await sdk.init();

      const bash = await sdk.Wasmer.fromRegistry('sharrattj/bash');
      const instance = await bash.entrypoint.run();

      instance.stdout.pipeTo(
        new WritableStream({
          write: (chunk) => {
            this.emulator.write(this.dec.decode(chunk));
            this.emitState();
          },
        }),
      );

      instance.stderr?.pipeTo(
        new WritableStream({
          write: (chunk) => {
            this.emulator.write(this.dec.decode(chunk));
            this.emitState();
          },
        }),
      );

      this.stdinWriter = instance.stdin?.getWriter() ?? null;

      // Bash needs ~1s to initialize before it can accept input
      await new Promise<void>((r) => setTimeout(r, 1000));

      this.connected = true;
      this.connectionInfoListeners.forEach((l) => l(0, 'bash'));
      this.keyBindingsListeners.forEach((l) => l(WASM_KEYBINDINGS));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errorListeners.forEach((l) => l(`bash.wasm failed to load: ${msg}`));
      throw e;
    }
  }

  disconnect(): void {
    this.stdinWriter?.close().catch(() => {});
    this.stdinWriter = null;
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
        this.cols = cols;
        this.rows = rows;
        this.emulator.resize(cols, rows);
        return this.buildState() as T;
      }

      case 'set_client_size': {
        const cols = (args?.cols as number) || 80;
        const rows = (args?.rows as number) || 24;
        this.cols = cols;
        this.rows = rows;
        this.emulator.resize(cols, rows);
        this.emitState();
        return null as T;
      }

      case 'run_tmux_command': {
        const command = args?.command as string;
        if (command) this.handleTmuxCommand(command);
        return null as T;
      }

      case 'get_key_bindings':
        return WASM_KEYBINDINGS as T;

      case 'ping':
      case 'initialize_session':
        return null as T;

      case 'get_scrollback_cells':
        return { cells: [], historySize: 0, start: 0, end: 0, width: this.cols } as T;

      case 'set_theme': {
        const name = args?.name as string | undefined;
        const mode = args?.mode as string | undefined;
        const saved = loadThemeFromStorage();
        saveThemeToStorage(
          name || saved?.theme || 'default',
          (mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : null) ?? saved?.mode ?? 'dark',
        );
        return null as T;
      }

      case 'set_theme_mode': {
        const setMode = (args?.mode === 'light' ? 'light' : 'dark') as 'dark' | 'light';
        const prev = loadThemeFromStorage();
        saveThemeToStorage(prev?.theme || 'default', setMode);
        return null as T;
      }

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
          { name: 'gruvbox-material', displayName: 'Gruvbox Material' },
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
    this.stateListeners.forEach((l) => l(this.buildState()));
  }

  private buildState(): ServerState {
    const { x: cursorX, y: cursorY } = this.emulator.getCursor();
    const pane: ServerPane = {
      id: 0,
      tmux_id: '%0',
      window_id: '@0',
      content: this.emulator.getCells(),
      cursor_x: cursorX,
      cursor_y: cursorY,
      width: this.cols,
      height: this.rows,
      x: 0,
      y: 0,
      active: true,
      command: 'bash',
      title: 'bash.wasm',
      border_title: '',
      in_mode: false,
      copy_cursor_x: 0,
      copy_cursor_y: 0,
    };
    const window: ServerWindow = {
      id: '@0',
      index: 0,
      name: 'bash',
      active: true,
      is_pane_group_window: false,
      pane_group_pane_ids: null,
    };
    return {
      session_name: 'wasm',
      active_window_id: '@0',
      active_pane_id: '%0',
      panes: [pane],
      windows: [window],
      total_width: this.cols,
      total_height: this.rows,
      status_line: '',
    };
  }

  private handleTmuxCommand(commandStr: string): void {
    for (const line of commandStr.split('\n')) {
      this.handleSingleCommand(line.trim());
    }
  }

  private handleSingleCommand(command: string): void {
    if (!command) return;
    const parts = this.parseTmuxCommand(command);
    if (parts.length === 0 || parts[0] !== 'send-keys') return;

    const args = parts.slice(1);
    let literal = false;
    const keys: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l') {
        literal = true;
      } else if (args[i] === '-t') {
        i++; // skip session target
      } else if (args[i] === '-X') {
        return; // copy-mode command — not applicable
      } else {
        keys.push(args[i]);
      }
    }

    if (keys.length === 0) return;

    if (literal) {
      const raw = unescapeLiteralText(keys.join(' '));
      this.writeStdin(raw);
    } else {
      for (const key of keys) {
        const bytes = KEY_MAP[key] ?? (key.length === 1 ? key : null);
        if (bytes !== null) this.writeStdin(bytes);
      }
    }
  }

  private writeStdin(text: string): void {
    if (this.stdinWriter) {
      this.stdinWriter.write(this.enc.encode(text)).catch(() => {});
    }
  }

  private parseTmuxCommand(command: string): string[] {
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
