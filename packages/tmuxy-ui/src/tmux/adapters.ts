import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  ServerState,
} from './types';
import { HttpAdapter } from './HttpAdapter';
import { DemoAdapter } from './demo/DemoAdapter';

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements TmuxAdapter {
  private connected = false;
  private unlisten: (() => void) | null = null;

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      this.unlisten = await listen<ServerState>('tmux-state-changed', (event) => {
        this.notifyStateChange(event.payload);
      });

      this.connected = true;

      // Tauri is always primary
      this.notifyConnectionInfo(0, 'bash');
    } catch (e) {
      this.notifyError('Failed to connect to Tauri');
      throw e;
    }
  }

  disconnect(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return false; // Tauri doesn't reconnect
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
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

  onKeyBindings(_listener: KeyBindingsListener): () => void {
    // Tauri doesn't support keybindings yet - no-op
    return () => {};
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
}

// ============================================
// Factory
// ============================================

function isTauri(): boolean {
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
