import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  LogListener,
  LogEntryKind,
  FatalListener,
  ClipboardListener,
  ServerState,
  StateUpdate,
  KeyBindings,
} from './types';
import { HttpAdapter } from './HttpAdapter';
import { DemoAdapter } from './demo/DemoAdapter';
import { handleStateUpdate, isDeltaSeqGap } from './deltaProtocol';
import { KeyBatcher } from './keyBatching';
import { latencyTracker } from './latencyTracker';

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements TmuxAdapter {
  readonly enumeratesSessions = true;
  private connected = false;
  private reconnectingState = false;
  private reconnectAttempt = 0;
  private unlistenFns: (() => void)[] = [];

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();
  private logListeners = new Set<LogListener>();
  private fatalListeners = new Set<FatalListener>();
  private clipboardListeners = new Set<ClipboardListener>();

  // Delta protocol state
  private currentState: ServerState | null = null;
  // Last applied delta seq (null right after a full snapshot) + cached client
  // size, so a dropped/misordered delta triggers a get_initial_state refetch
  // instead of diverging. The Tauri event channel has no ring-buffer replay,
  // so this is the only recovery path on that transport.
  private lastDeltaSeq: number | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private resyncing = false;

  // Keyboard batching
  private keyBatcher: KeyBatcher | null = null;

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { invoke } = await import('@tauri-apps/api/core');

      // Initialize key batcher. The flushed batches MUST go through the same
      // serial queue as run_tmux_command: tauri::invoke spawns each call as its
      // own task with no cross-command ordering, so an unqueued keystroke batch
      // can overtake a queued mutation (or another batch) and land out of order
      // — the exact reordering the serial queue exists to prevent (HttpAdapter
      // routes its batches through sendQueue for the same reason).
      this.keyBatcher = new KeyBatcher((cmd, args) => {
        latencyTracker.markInput();
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await invoke(cmd, args);
          } catch {
            // Ignore errors for fire-and-forget batched commands
          }
        });
      });

      // Listen for state updates (full or delta)
      const unlistenState = await listen<StateUpdate>('tmux-state-update', (event) => {
        const update = event.payload;

        // Delta seq-gap detection (see HttpAdapter): a dropped delta would
        // apply to stale state and diverge. On a gap, refetch a full snapshot.
        if (update.type === 'delta') {
          if (isDeltaSeqGap(this.lastDeltaSeq, update.delta)) {
            this.lastDeltaSeq = null;
            void this.resyncFullState();
            return;
          }
          this.lastDeltaSeq = update.delta.seq;
        } else {
          this.lastDeltaSeq = null;
        }

        const newState = handleStateUpdate(update, this.currentState);
        if (newState) {
          this.currentState = newState;
          this.notifyStateChange(newState);
        }

        // A successful state update means we're connected
        if (!this.connected) {
          this.connected = true;
        }
        if (this.reconnectingState) {
          this.reconnectingState = false;
          this.reconnectAttempt = 0;
          this.notifyReconnection(false, 0);
        }
      });
      this.unlistenFns.push(unlistenState);

      // Listen for keybindings
      const unlistenKeybindings = await listen<KeyBindings>('tmux-keybindings', (event) => {
        this.notifyKeyBindings(event.payload);
      });
      this.unlistenFns.push(unlistenKeybindings);

      // Listen for streaming connection-time progress (each command + output)
      const unlistenLog = await listen<{ kind: LogEntryKind; message: string }>(
        'tmux-log',
        (event) => {
          this.notifyLog(event.payload.kind, event.payload.message);
        },
      );
      this.unlistenFns.push(unlistenLog);

      // OSC 52 clipboard write requests from terminal applications, forwarded
      // by monitor.rs. Mirrored into the system clipboard by the tmux actor.
      // Without this the desktop app silently drops every terminal clipboard
      // write (HttpAdapter has the same listener).
      const unlistenClipboard = await listen<{ pane_id: string; text: string }>(
        'tmux-clipboard',
        (event) => {
          this.notifyClipboard(event.payload.pane_id, event.payload.text);
        },
      );
      this.unlistenFns.push(unlistenClipboard);

      // Backend gave up reconnecting — terminal state, no further events.
      const unlistenFatal = await listen<{ message: string }>('tmux-fatal', (event) => {
        this.connected = false;
        this.reconnectingState = false;
        this.notifyFatal(event.payload.message);
      });
      this.unlistenFns.push(unlistenFatal);

      // Listen for errors (emitted by monitor.rs on connection failure)
      const unlistenError = await listen<string>('tmux-error', (event) => {
        this.notifyError(event.payload);

        // If we were connected, we're now reconnecting
        if (this.connected) {
          this.connected = false;
          this.reconnectingState = true;
          this.reconnectAttempt++;
          this.notifyReconnection(true, this.reconnectAttempt);
        } else if (!this.reconnectingState) {
          // First connection attempt failed — mark as reconnecting
          this.reconnectingState = true;
          this.reconnectAttempt++;
          this.notifyReconnection(true, this.reconnectAttempt);
        } else {
          // Subsequent reconnection failure
          this.reconnectAttempt++;
          this.notifyReconnection(true, this.reconnectAttempt);
        }
      });
      this.unlistenFns.push(unlistenError);

      this.connected = true;

      // Tauri is always primary
      this.notifyConnectionInfo(0, 'bash');

      // Backfill keybindings: the backend's first `tmux-keybindings` event
      // can fire before this listener is attached (especially on a fresh
      // launch where the WebView is still booting). Without this fetch the
      // prefix indicator stays hidden and prefix/root bindings are empty,
      // so prefix-key and Ctrl+hjkl silently no-op.
      try {
        const snapshot = await invoke<KeyBindings | null>('get_keybindings_snapshot');
        if (snapshot) {
          this.notifyKeyBindings(snapshot);
        }
      } catch {
        // Older app builds won't have the command — fall through silently.
      }
    } catch (e) {
      this.notifyError('Failed to connect to Tauri');
      throw e;
    }
  }

  disconnect(): void {
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];

    if (this.keyBatcher) {
      this.keyBatcher.destroy();
      this.keyBatcher = null;
    }

    this.connected = false;
    this.reconnectingState = false;
    this.reconnectAttempt = 0;
    this.currentState = null;
    this.lastDeltaSeq = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return this.reconnectingState;
  }

  // Serial queue for mutating commands so they reach the Tauri executor in
  // issue order. Same rationale as HttpAdapter: tauri::invoke spawns each
  // command as its own task and tmux's external subprocess calls have no
  // cross-command ordering guarantee. A `split-window -h` racing past a
  // `select-window -t @B` would split the previous tab.
  private sendQueue: Promise<void> = Promise.resolve();

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');

    // Cache the client size so a seq-gap resync can refetch get_initial_state.
    if (
      (cmd === 'set_client_size' || cmd === 'get_initial_state') &&
      typeof args?.cols === 'number' &&
      typeof args?.rows === 'number'
    ) {
      this.lastCols = args.cols;
      this.lastRows = args.rows;
    }

    // Special handling for get_initial_state: capture as currentState for delta protocol
    if (cmd === 'get_initial_state') {
      const result = await invoke<T>(cmd, args);
      this.currentState = result as ServerState;
      this.lastDeltaSeq = null;
      return result;
    }

    // Check if this is a send-keys command that should be batched
    if (this.keyBatcher?.intercept(cmd, args)) {
      return Promise.resolve(undefined as T);
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.keyBatcher?.flushAll();

    if (cmd === 'run_tmux_command') {
      latencyTracker.markInput();
      let resolveOuter!: (value: T | PromiseLike<T>) => void;
      let rejectOuter!: (reason: unknown) => void;
      const outer = new Promise<T>((res, rej) => {
        resolveOuter = res;
        rejectOuter = rej;
      });
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          const result = await invoke<T>(cmd, args);
          resolveOuter(result);
        } catch (err) {
          rejectOuter(err);
        }
      });
      return outer;
    }

    return invoke(cmd, args);
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

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onFatal(listener: FatalListener): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  onClipboard(listener: ClipboardListener): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
  }

  private notifyStateChange(state: ServerState) {
    // Closes the oldest outstanding input's round trip and feeds update-rate /
    // stall metrics (Axis-B, see latencyTracker).
    latencyTracker.recordUpdate();
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyLog(kind: LogEntryKind, message: string) {
    this.logListeners.forEach((listener) => listener(kind, message));
  }

  private notifyFatal(message: string) {
    this.fatalListeners.forEach((listener) => listener(message));
  }

  private notifyError(error: string) {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyConnectionInfo(connectionId: number, defaultShell: string) {
    this.connectionInfoListeners.forEach((listener) => listener(connectionId, defaultShell));
  }

  private notifyReconnection(reconnecting: boolean, attempt: number) {
    this.reconnectionListeners.forEach((listener) => listener(reconnecting, attempt));
  }

  async switchSession(newSession: string): Promise<void> {
    // For Tauri, use switch-client to change the tmux session
    await this.invoke<void>('run_tmux_command', { command: `switch-client -t ${newSession}` });
  }

  private notifyKeyBindings(keybindings: KeyBindings) {
    this.keyBindingsListeners.forEach((listener) => listener(keybindings));
  }

  private notifyClipboard(paneId: string, text: string) {
    this.clipboardListeners.forEach((listener) => listener(paneId, text));
  }

  /** Refetch a full snapshot after a delta seq gap (see HttpAdapter). */
  private async resyncFullState(): Promise<void> {
    if (this.resyncing) return;
    if (this.lastCols === 0 || this.lastRows === 0) return;
    this.resyncing = true;
    try {
      const state = await this.invoke<ServerState>('get_initial_state', {
        cols: this.lastCols,
        rows: this.lastRows,
      });
      // invoke() already set currentState + reset lastDeltaSeq.
      this.notifyStateChange(state);
    } catch (e) {
      console.error('Delta seq-gap resync failed; awaiting next full snapshot:', e);
    } finally {
      this.resyncing = false;
    }
  }
}

// ============================================
// Factory
// ============================================

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isDemo(): boolean {
  return typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('demo');
}

export function createAdapter(): TmuxAdapter {
  if (isTauri()) {
    return new TauriAdapter();
  }
  if (isDemo()) {
    return new DemoAdapter();
  }
  return new HttpAdapter();
}
