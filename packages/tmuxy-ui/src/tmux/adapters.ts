import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  PrimaryChangedListener,
  ServerState,
  ServerPane,
  ServerWindow,
  StateUpdate,
  ServerDelta,
  PaneDelta,
  WindowDelta,
} from './types';

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
  type: 'response' | 'error' | 'event' | 'connection_info' | 'primary_changed';
  id?: string;
  result?: unknown;
  error?: string;
  name?: string;
  payload?: unknown;
  // For connection_info message
  connection_id?: number;
  is_primary?: boolean;
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

// Batching constants
const KEY_BATCH_INTERVAL_MS = 16; // Batch keystrokes within ~1 frame

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
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private primaryChangedListeners = new Set<PrimaryChangedListener>();

  // Keyboard batching state
  private pendingKeys: Map<string, string[]> = new Map(); // session -> keys[]
  private keyBatchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Delta protocol state
  private currentState: ServerState | null = null;

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

    // Clear any pending key batch timeout
    if (this.keyBatchTimeout) {
      clearTimeout(this.keyBatchTimeout);
      this.keyBatchTimeout = null;
    }
    this.pendingKeys.clear();

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

  /**
   * Flush batched keystrokes to tmux
   */
  private flushKeyBatch(): void {
    this.keyBatchTimeout = null;

    for (const [session, keys] of this.pendingKeys) {
      if (keys.length === 0) continue;

      // Combine all keys into a single send-keys command
      const combinedKeys = keys.join(' ');
      const command = `send-keys -t ${session} ${combinedKeys}`;

      // Send immediately without batching (to avoid recursion)
      this.sendCommand('run_tmux_command', { command });
    }

    this.pendingKeys.clear();
  }

  /**
   * Send a command directly without batching
   */
  private sendCommand(cmd: string, args: Record<string, unknown>): void {
    const id = generateUUID();
    const message = JSON.stringify({
      type: 'invoke',
      id,
      cmd,
      args,
    });

    if (this.connected && this.ws) {
      this.ws.send(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    // Check if this is a send-keys command that should be batched
    if (cmd === 'run_tmux_command' && args?.command) {
      const command = args.command as string;
      const sendKeysMatch = command.match(/^send-keys -t (\S+) (.+)$/);

      if (sendKeysMatch) {
        const [, session, keys] = sendKeysMatch;

        // Add keys to pending batch
        if (!this.pendingKeys.has(session)) {
          this.pendingKeys.set(session, []);
        }
        this.pendingKeys.get(session)!.push(keys);

        // Schedule flush if not already scheduled
        if (!this.keyBatchTimeout) {
          this.keyBatchTimeout = setTimeout(() => this.flushKeyBatch(), KEY_BATCH_INTERVAL_MS);
        }

        // Return immediately - batched commands don't wait for response
        return Promise.resolve(undefined as T);
      }
    }

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

  onConnectionInfo(listener: ConnectionInfoListener): () => void {
    this.connectionInfoListeners.add(listener);
    return () => this.connectionInfoListeners.delete(listener);
  }

  onPrimaryChanged(listener: PrimaryChangedListener): () => void {
    this.primaryChangedListeners.add(listener);
    return () => this.primaryChangedListeners.delete(listener);
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
        // Legacy full state update (for backwards compatibility)
        const state = msg.payload as ServerState;
        this.currentState = state;
        this.notifyStateChange(state);
      } else if (msg.type === 'event' && msg.name === 'tmux-state-update') {
        // New delta protocol
        const update = msg.payload as StateUpdate;
        this.handleStateUpdate(update);
      } else if (msg.type === 'event' && msg.name === 'tmux-error') {
        const error = msg.payload as { message: string };
        this.notifyError(error.message);
      } else if (msg.type === 'connection_info') {
        this.notifyConnectionInfo(msg.connection_id ?? 0, msg.is_primary ?? false);
      } else if (msg.type === 'primary_changed') {
        this.notifyPrimaryChanged(msg.is_primary ?? false);
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

  private notifyConnectionInfo(connectionId: number, isPrimary: boolean) {
    this.connectionInfoListeners.forEach((listener) => listener(connectionId, isPrimary));
  }

  private notifyPrimaryChanged(isPrimary: boolean) {
    this.primaryChangedListeners.forEach((listener) => listener(isPrimary));
  }

  /**
   * Handle StateUpdate (full or delta)
   */
  private handleStateUpdate(update: StateUpdate): void {
    if (update.type === 'full') {
      // Full state - just use it directly
      this.currentState = update.state;
      this.notifyStateChange(update.state);
    } else {
      // Delta update - apply to current state
      const delta = update.delta;

      // Check for sequence gaps (would require full resync)
      if (this.currentState === null) {
        // No current state - wait for full state
        console.warn('Received delta before full state, ignoring');
        return;
      }

      // Apply delta to current state
      const newState = this.applyDelta(this.currentState, delta);
      this.currentState = newState;
      this.notifyStateChange(newState);
    }
  }

  /**
   * Apply a delta to the current state and return a new state
   */
  private applyDelta(state: ServerState, delta: ServerDelta): ServerState {
    // Create a shallow copy
    const newState: ServerState = { ...state };

    // Apply top-level field changes
    if (delta.active_window_id !== undefined) {
      newState.active_window_id = delta.active_window_id;
    }
    if (delta.active_pane_id !== undefined) {
      newState.active_pane_id = delta.active_pane_id;
    }
    if (delta.status_line !== undefined) {
      newState.status_line = delta.status_line;
    }
    if (delta.total_width !== undefined) {
      newState.total_width = delta.total_width;
    }
    if (delta.total_height !== undefined) {
      newState.total_height = delta.total_height;
    }

    // Apply pane changes
    if (delta.panes || delta.new_panes) {
      // Build a map of current panes by tmux_id
      const paneMap = new Map<string, ServerPane>();
      for (const pane of state.panes) {
        paneMap.set(pane.tmux_id, pane);
      }

      // Apply deltas to existing panes
      if (delta.panes) {
        for (const [paneId, paneDelta] of Object.entries(delta.panes)) {
          if (paneDelta === null) {
            // Pane removed
            paneMap.delete(paneId);
          } else {
            // Pane modified
            const existing = paneMap.get(paneId);
            if (existing) {
              paneMap.set(paneId, this.applyPaneDelta(existing, paneDelta));
            }
          }
        }
      }

      // Add new panes
      if (delta.new_panes) {
        for (const newPane of delta.new_panes) {
          paneMap.set(newPane.tmux_id, newPane);
        }
      }

      newState.panes = Array.from(paneMap.values());
    }

    // Apply window changes
    if (delta.windows || delta.new_windows) {
      // Build a map of current windows by id
      const windowMap = new Map<string, ServerWindow>();
      for (const window of state.windows) {
        windowMap.set(window.id, window);
      }

      // Apply deltas to existing windows
      if (delta.windows) {
        for (const [windowId, windowDelta] of Object.entries(delta.windows)) {
          if (windowDelta === null) {
            // Window removed
            windowMap.delete(windowId);
          } else {
            // Window modified
            const existing = windowMap.get(windowId);
            if (existing) {
              windowMap.set(windowId, this.applyWindowDelta(existing, windowDelta));
            }
          }
        }
      }

      // Add new windows
      if (delta.new_windows) {
        for (const newWindow of delta.new_windows) {
          windowMap.set(newWindow.id, newWindow);
        }
      }

      newState.windows = Array.from(windowMap.values());
    }

    return newState;
  }

  /**
   * Apply a pane delta to an existing pane
   */
  private applyPaneDelta(pane: ServerPane, delta: PaneDelta): ServerPane {
    return {
      ...pane,
      ...(delta.content !== undefined && { content: delta.content }),
      ...(delta.cursor_x !== undefined && { cursor_x: delta.cursor_x }),
      ...(delta.cursor_y !== undefined && { cursor_y: delta.cursor_y }),
      ...(delta.width !== undefined && { width: delta.width }),
      ...(delta.height !== undefined && { height: delta.height }),
      ...(delta.x !== undefined && { x: delta.x }),
      ...(delta.y !== undefined && { y: delta.y }),
      ...(delta.active !== undefined && { active: delta.active }),
      ...(delta.command !== undefined && { command: delta.command }),
      ...(delta.title !== undefined && { title: delta.title }),
      ...(delta.border_title !== undefined && { border_title: delta.border_title }),
      ...(delta.in_mode !== undefined && { in_mode: delta.in_mode }),
      ...(delta.copy_cursor_x !== undefined && { copy_cursor_x: delta.copy_cursor_x }),
      ...(delta.copy_cursor_y !== undefined && { copy_cursor_y: delta.copy_cursor_y }),
      ...(delta.alternate_on !== undefined && { alternate_on: delta.alternate_on }),
      ...(delta.mouse_any_flag !== undefined && { mouse_any_flag: delta.mouse_any_flag }),
      ...(delta.paused !== undefined && { paused: delta.paused }),
    };
  }

  /**
   * Apply a window delta to an existing window
   */
  private applyWindowDelta(window: ServerWindow, delta: WindowDelta): ServerWindow {
    return {
      ...window,
      ...(delta.name !== undefined && { name: delta.name }),
      ...(delta.active !== undefined && { active: delta.active }),
      ...(delta.is_stack_window !== undefined && { is_stack_window: delta.is_stack_window }),
      ...(delta.stack_parent_pane !== undefined && { stack_parent_pane: delta.stack_parent_pane }),
      ...(delta.stack_index !== undefined && { stack_index: delta.stack_index }),
    };
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
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private primaryChangedListeners = new Set<PrimaryChangedListener>();

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      this.unlisten = await listen<ServerState>('tmux-state-changed', (event) => {
        this.notifyStateChange(event.payload);
      });

      this.connected = true;

      // Tauri is always primary
      this.notifyConnectionInfo(0, true);
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

  onConnectionInfo(listener: ConnectionInfoListener): () => void {
    this.connectionInfoListeners.add(listener);
    return () => this.connectionInfoListeners.delete(listener);
  }

  onPrimaryChanged(listener: PrimaryChangedListener): () => void {
    this.primaryChangedListeners.add(listener);
    return () => this.primaryChangedListeners.delete(listener);
  }

  private notifyStateChange(state: ServerState) {
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyError(error: string) {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyConnectionInfo(connectionId: number, isPrimary: boolean) {
    this.connectionInfoListeners.forEach((listener) => listener(connectionId, isPrimary));
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
