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
import { handleStateUpdate } from './deltaProtocol';
import { KeyBatcher } from './keyBatching';

// Reconnection constants (for EventSource manual reconnection with backoff)
const MAX_RECONNECT_DELAY_MS = 30000;
const INITIAL_RECONNECT_DELAY_MS = 1000;

/**
 * Get the session name from URL query parameters.
 * Falls back to 'tmuxy' if not specified.
 */
function getSessionFromUrl(): string {
  if (typeof window === 'undefined') return 'tmuxy';
  const params = new URLSearchParams(window.location.search);
  return params.get('session') || 'tmuxy';
}

/**
 * HTTP Adapter using SSE for server->client push and POST for client->server commands
 */
export class HttpAdapter implements TmuxAdapter {
  private eventSource: EventSource | null = null;
  private sessionToken: string | null = null;
  private connected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();

  // Delta protocol state
  private currentState: ServerState | null = null;

  // Keyboard batching
  private keyBatcher = new KeyBatcher((cmd, args) => this.sendCommandFireAndForget(cmd, args));

  connect(): Promise<void> {
    if (this.connected && this.eventSource) return Promise.resolve();

    this.intentionalDisconnect = false;

    return new Promise((resolve, reject) => {
      const session = getSessionFromUrl();
      const protocol = window.location.protocol;
      const host = window.location.host || 'localhost:3853';
      const eventsUrl = `${protocol}//${host}/events?session=${encodeURIComponent(session)}`;

      this.eventSource = new EventSource(eventsUrl);

      this.eventSource.addEventListener('connection-info', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.sessionToken = data.data?.session_token || data.session_token;
          this.connected = true;
          this.reconnectAttempts = 0;

          // Clear reconnecting state if was reconnecting
          if (this.reconnecting) {
            this.reconnecting = false;
            this.notifyReconnection(false, 0);
          }

          const connectionId = data.data?.connection_id ?? data.connection_id ?? 0;
          const defaultShell = data.data?.default_shell ?? data.default_shell ?? 'bash';
          this.notifyConnectionInfo(connectionId, defaultShell);
          resolve();
        } catch (e) {
          console.error('Failed to parse connection-info:', e);
        }
      });

      this.eventSource.addEventListener('state-update', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          // Handle nested structure from server
          const update: StateUpdate = data.data || data;
          const newState = handleStateUpdate(update, this.currentState);
          if (newState) {
            this.currentState = newState;
            this.notifyStateChange(newState);
          }
        } catch (e) {
          console.error('Failed to parse state-update:', e);
        }
      });

      this.eventSource.addEventListener('keybindings', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const keybindings: KeyBindings = data.data || data;
          this.notifyKeyBindings(keybindings);
        } catch (e) {
          console.error('Failed to parse keybindings:', e);
        }
      });

      this.eventSource.addEventListener('error', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const message = data.data?.message || data.message || 'Unknown error';
          this.notifyError(message);
        } catch {
          // Not a JSON error event, might be connection error
        }
      });

      this.eventSource.onerror = () => {
        if (!this.connected) {
          // Connection failed to establish
          this.notifyError('Failed to connect to SSE');
          reject(new Error('Failed to connect to SSE'));
          return;
        }

        // Connection lost - attempt reconnect
        this.connected = false;
        this.sessionToken = null;

        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }

        if (!this.intentionalDisconnect) {
          this.attemptReconnect();
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.reconnecting = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.keyBatcher.destroy();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.connected = false;
    this.sessionToken = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return this.reconnecting;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    // Special handling for get_initial_state: also set currentState so delta updates work
    if (cmd === 'get_initial_state') {
      const result = await this.invokeInternal<T>(cmd, args);
      this.currentState = result as ServerState;
      return result;
    }

    // Check if this is a send-keys command that should be batched
    if (this.keyBatcher.intercept(cmd, args)) {
      return Promise.resolve(undefined as T);
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.keyBatcher.flushAll();

    return this.invokeInternal(cmd, args);
  }

  /**
   * Send a command without waiting for response (fire and forget)
   */
  private sendCommandFireAndForget(cmd: string, args: Record<string, unknown>): void {
    if (!this.sessionToken) {
      console.warn('[HttpAdapter] No session token, cannot send command');
      return;
    }

    const session = getSessionFromUrl();
    const protocol = window.location.protocol;
    const host = window.location.host || 'localhost:3853';
    const commandsUrl = `${protocol}//${host}/commands?session=${encodeURIComponent(session)}`;

    fetch(commandsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
      },
      body: JSON.stringify({ cmd, args }),
    }).catch(() => {
      // Ignore errors for fire-and-forget commands
    });
  }

  /**
   * Internal invoke implementation
   */
  private async invokeInternal<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.sessionToken) {
      // Wait for connection if not connected
      if (!this.connected) {
        await this.connect();
      }
      if (!this.sessionToken) {
        throw new Error('No session token available');
      }
    }

    const session = getSessionFromUrl();
    const protocol = window.location.protocol;
    const host = window.location.host || 'localhost:3853';
    const commandsUrl = `${protocol}//${host}/commands?session=${encodeURIComponent(session)}`;

    const response = await fetch(commandsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
      },
      body: JSON.stringify({ cmd, args: args || {} }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data.result as T;
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

  private attemptReconnect(): void {
    if (!this.reconnecting) {
      this.reconnecting = true;
    }

    this.reconnectAttempts++;
    this.notifyReconnection(true, this.reconnectAttempts);

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    console.log(`[HttpAdapter] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((err) => {
        console.error('[HttpAdapter] Reconnect failed:', err);
        // Will trigger onerror which calls attemptReconnect again
      });
    }, delay);
  }

  private notifyStateChange(state: ServerState): void {
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyError(error: string): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyConnectionInfo(connectionId: number, defaultShell: string): void {
    this.connectionInfoListeners.forEach((listener) => listener(connectionId, defaultShell));
  }

  private notifyReconnection(reconnecting: boolean, attempt: number): void {
    this.reconnectionListeners.forEach((listener) => listener(reconnecting, attempt));
  }

  private notifyKeyBindings(keybindings: KeyBindings): void {
    this.keyBindingsListeners.forEach((listener) => listener(keybindings));
  }
}
