import { TmuxAdapter, StateListener, ErrorListener, ServerState } from './types';

// UUID generator with fallback for non-secure contexts
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (e.g., HTTP, headless browsers)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================
// WebSocket Adapter
// ============================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface ServerMessage {
  type: 'response' | 'error' | 'event';
  id?: string;
  result?: unknown;
  error?: string;
  name?: string;
  payload?: unknown;
}

/**
 * Get the session name from URL query parameters.
 * Falls back to 'tmuxy' if not specified.
 */
function getSessionFromUrl(): string {
  if (typeof window === 'undefined') return 'tmuxy';
  const params = new URLSearchParams(window.location.search);
  return params.get('session') || 'tmuxy';
}

export class WebSocketAdapter implements TmuxAdapter {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private messageQueue: string[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private connecting: Promise<void> | null = null;
  private connected = false;
  private intentionalDisconnect = false; // Prevent auto-reconnect on explicit disconnect

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.intentionalDisconnect = false; // Reset flag on connect

    this.connecting = new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host || 'localhost:3853';
      const session = getSessionFromUrl();
      const wsUrl = `${protocol}//${host}/ws?session=${encodeURIComponent(session)}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.connecting = null;
        this.reconnectAttempts = 0;

        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          if (msg) this.ws?.send(msg);
        }

        resolve();
      };

      this.ws.onerror = () => {
        this.connecting = null;
        if (!this.connected) {
          this.notifyError('Failed to connect to WebSocket');
          reject(new Error('Failed to connect to WebSocket'));
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        // Only auto-reconnect if not intentionally disconnected
        if (!this.intentionalDisconnect) {
          this.attemptReconnect();
        }
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });

    return this.connecting;
  }

  disconnect(): void {
    this.intentionalDisconnect = true; // Prevent auto-reconnect
    this.reconnectAttempts = 0; // Reset reconnect counter

    // Only close WebSocket if it's actually open
    // If it's still CONNECTING, let it connect first (React StrictMode handling)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.connecting = null;
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      // Don't close a connecting WebSocket - let it finish
      // The next connect() call will reuse it
    } else {
      this.ws = null;
      this.connected = false;
      this.connecting = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = generateUUID();

    const message = JSON.stringify({
      type: 'invoke',
      id,
      cmd,
      args: args || {},
    });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      if (this.connected && this.ws) {
        this.ws.send(message);
      } else {
        this.messageQueue.push(message);
        this.connect().catch(reject);
      }

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
      setTimeout(() => {
        this.connect().catch(console.error);
      }, delay);
    }
  }

  private handleMessage(data: string) {
    try {
      const msg: ServerMessage = JSON.parse(data);

      if (msg.type === 'response' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.result);
          this.pendingRequests.delete(msg.id);
        }
      } else if (msg.type === 'error' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.reject(new Error(msg.error || 'Unknown error'));
          this.pendingRequests.delete(msg.id);
        }
      } else if (msg.type === 'event' && msg.name === 'tmux-state-changed') {
        this.notifyStateChange(msg.payload as ServerState);
      } else if (msg.type === 'event' && msg.name === 'tmux-error') {
        const error = msg.payload as { message: string };
        this.notifyError(error.message);
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  private notifyStateChange(state: ServerState) {
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyError(error: string) {
    this.errorListeners.forEach((listener) => listener(error));
  }
}

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements TmuxAdapter {
  private connected = false;
  private unlisten: (() => void) | null = null;

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      this.unlisten = await listen<ServerState>('tmux-state-changed', (event) => {
        this.notifyStateChange(event.payload);
      });

      this.connected = true;
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

  private notifyStateChange(state: ServerState) {
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyError(error: string) {
    this.errorListeners.forEach((listener) => listener(error));
  }
}

// ============================================
// Factory
// ============================================

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export function createAdapter(): TmuxAdapter {
  if (isTauri()) {
    return new TauriAdapter();
  }
  return new WebSocketAdapter();
}
