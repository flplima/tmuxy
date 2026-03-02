import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  ServerState,
  StateUpdate,
  KeyBindings,
} from './types';
import { HttpAdapter } from './HttpAdapter';
import { DemoAdapter } from './demo/DemoAdapter';
import { handleStateUpdate } from './deltaProtocol';
import { KeyBatcher } from './keyBatching';

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements TmuxAdapter {
  private connected = false;
  private reconnectingState = false;
  private reconnectAttempt = 0;
  private unlistenFns: (() => void)[] = [];

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();

  // Delta protocol state
  private currentState: ServerState | null = null;

  // Keyboard batching
  private keyBatcher: KeyBatcher | null = null;

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { invoke } = await import('@tauri-apps/api/core');

      // Initialize key batcher with Tauri invoke as the send function
      this.keyBatcher = new KeyBatcher((cmd, args) => {
        invoke(cmd, args).catch(() => {
          // Ignore errors for fire-and-forget batched commands
        });
      });

      // Listen for state updates (full or delta)
      const unlistenState = await listen<StateUpdate>('tmux-state-update', (event) => {
        const update = event.payload;
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
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return this.reconnectingState;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');

    // Special handling for get_initial_state: capture as currentState for delta protocol
    if (cmd === 'get_initial_state') {
      const result = await invoke<T>(cmd, args);
      this.currentState = result as ServerState;
      return result;
    }

    // Check if this is a send-keys command that should be batched
    if (this.keyBatcher?.intercept(cmd, args)) {
      return Promise.resolve(undefined as T);
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.keyBatcher?.flushAll();

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

  private notifyStateChange(state: ServerState) {
    this.stateListeners.forEach((listener) => listener(state));
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
}

// ============================================
// Factory
// ============================================

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
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
