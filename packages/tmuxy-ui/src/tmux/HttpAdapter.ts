import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  ServerState,
  ServerPane,
  ServerWindow,
  StateUpdate,
  ServerDelta,
  PaneDelta,
  WindowDelta,
  KeyBindings,
} from './types';

// Batching constants
const KEY_BATCH_INTERVAL_MS = 16; // Batch keystrokes within ~1 frame

/**
 * Escape text for use with tmux send-keys -l (literal mode).
 * Wraps in single quotes, escaping internal single quotes.
 */
function escapeLiteralText(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * Unescape literal text from tmux send-keys -l format.
 * Reverses: 'text' → text, 'it'\''s' → it's
 */
function unescapeLiteralText(escaped: string): string {
  // Must start and end with single quote (possibly with '\'' sequences)
  if (!escaped.startsWith("'")) return escaped;
  // Remove outer quotes and unescape internal '\'' sequences
  // The pattern is: 'text' with internal quotes escaped as '\''
  // So 'it'\''s' is: 'it' + \' + 's' → it's
  let result = '';
  let i = 1; // skip opening quote
  while (i < escaped.length) {
    if (escaped[i] === "'" && escaped.substring(i, i + 4) === "'\\''" && i + 4 <= escaped.length) {
      // Found '\'' escape sequence
      result += "'";
      i += 4;
    } else if (escaped[i] === "'") {
      // Closing quote
      break;
    } else {
      result += escaped[i];
      i++;
    }
  }
  return result;
}

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

  // Unified keystroke batching: ordered list of tmux commands per session.
  // Literal chars accumulate as raw text in the last entry (if it's a literal
  // entry); special keys are stored as individual command strings.  On flush,
  // each entry becomes one tmux command and they're sent \n-joined in a single
  // HTTP POST so the backend processes them atomically and in order.
  private pendingKeyCommands: Map<
    string,
    Array<{ type: 'literal'; text: string } | { type: 'special'; keys: string[] }>
  > = new Map();
  private keyBatchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Delta protocol state
  private currentState: ServerState | null = null;

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
          this.handleStateUpdate(update);
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

    // Clear any pending reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Clear any pending key batch timeout
    if (this.keyBatchTimeout) {
      clearTimeout(this.keyBatchTimeout);
      this.keyBatchTimeout = null;
    }
    this.pendingKeyCommands.clear();

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
    if (cmd === 'run_tmux_command' && args?.command) {
      const command = args.command as string;

      // Match literal send-keys: send-keys -t SESSION -l 'ESCAPED_TEXT'
      const literalMatch = command.match(/^send-keys -t (\S+) -l (.+)$/);
      if (literalMatch) {
        const [, session, escapedText] = literalMatch;
        const rawText = unescapeLiteralText(escapedText);

        if (!this.pendingKeyCommands.has(session)) {
          this.pendingKeyCommands.set(session, []);
        }
        const queue = this.pendingKeyCommands.get(session)!;

        // Coalesce with previous literal entry if it exists
        const last = queue[queue.length - 1];
        if (last && last.type === 'literal') {
          last.text += rawText;
        } else {
          queue.push({ type: 'literal', text: rawText });
        }

        // Schedule flush if not already scheduled
        if (!this.keyBatchTimeout) {
          this.keyBatchTimeout = setTimeout(() => this.flushKeyBatch(), KEY_BATCH_INTERVAL_MS);
        }

        return Promise.resolve(undefined as T);
      }

      // Match special (non-literal) send-keys: send-keys -t SESSION KEYS
      const sendKeysMatch = command.match(/^send-keys -t (\S+) (?!-l )(.+)$/);
      if (sendKeysMatch) {
        const [, session, keys] = sendKeysMatch;

        if (!this.pendingKeyCommands.has(session)) {
          this.pendingKeyCommands.set(session, []);
        }
        const queue = this.pendingKeyCommands.get(session)!;

        // Coalesce with previous special entry if it exists
        const last = queue[queue.length - 1];
        if (last && last.type === 'special') {
          last.keys.push(keys);
        } else {
          queue.push({ type: 'special', keys: [keys] });
        }

        // Schedule flush if not already scheduled
        if (!this.keyBatchTimeout) {
          this.keyBatchTimeout = setTimeout(() => this.flushKeyBatch(), KEY_BATCH_INTERVAL_MS);
        }

        return Promise.resolve(undefined as T);
      }
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.flushAllBatches();

    return this.invokeInternal(cmd, args);
  }

  /**
   * Flush all batched keystrokes to tmux.
   * Converts the ordered queue for each session into \n-joined tmux commands
   * sent in a single HTTP POST, preserving the exact keystroke order.
   */
  private flushKeyBatch(): void {
    this.keyBatchTimeout = null;

    for (const [session, queue] of this.pendingKeyCommands) {
      if (queue.length === 0) continue;

      const commands: string[] = [];
      for (const entry of queue) {
        if (entry.type === 'literal') {
          commands.push(`send-keys -t ${session} -l ${escapeLiteralText(entry.text)}`);
        } else {
          commands.push(`send-keys -t ${session} ${entry.keys.join(' ')}`);
        }
      }

      // Send all commands as \n-joined string — the backend writes this to
      // control mode stdin and processes each line as a separate command in order.
      this.sendCommandFireAndForget('run_tmux_command', {
        command: commands.join('\n'),
      });
    }

    this.pendingKeyCommands.clear();
  }

  /**
   * Flush all pending batches (called before non-batched commands)
   */
  private flushAllBatches(): void {
    if (this.keyBatchTimeout) {
      clearTimeout(this.keyBatchTimeout);
      this.keyBatchTimeout = null;
    }
    this.flushKeyBatch();
  }

  // Serialized send queue: ensures keystroke HTTP requests are sent one at a
  // time so they arrive at the server in order.  Without this, concurrent
  // fire-and-forget POSTs can arrive out of order, causing character
  // transposition.
  private sendQueue: Promise<void> = Promise.resolve();

  /**
   * Send a command in order (serialized, but caller doesn't await)
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
    const token = this.sessionToken;

    // Chain onto the serial queue so requests go one at a time
    this.sendQueue = this.sendQueue.then(() =>
      fetch(commandsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify({ cmd, args }),
      })
        .then(() => {})
        .catch(() => {}),
    );
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

  /**
   * Handle StateUpdate (full or delta)
   */
  private handleStateUpdate(update: StateUpdate): void {
    if (update.type === 'full') {
      this.currentState = update.state;
      this.notifyStateChange(update.state);
    } else if (update.type === 'delta') {
      const delta = update.delta;

      if (this.currentState === null) {
        console.warn('Received delta before full state, ignoring');
        return;
      }

      const newState = this.applyDelta(this.currentState, delta);
      this.currentState = newState;
      this.notifyStateChange(newState);
    }
  }

  /**
   * Apply a delta to the current state and return a new state
   */
  private applyDelta(state: ServerState, delta: ServerDelta): ServerState {
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
      const paneMap = new Map<string, ServerPane>();
      for (const pane of state.panes) {
        paneMap.set(pane.tmux_id, pane);
      }

      if (delta.panes) {
        for (const [paneId, paneDelta] of Object.entries(delta.panes)) {
          if (paneDelta === null) {
            paneMap.delete(paneId);
          } else {
            const existing = paneMap.get(paneId);
            if (existing) {
              paneMap.set(paneId, this.applyPaneDelta(existing, paneDelta));
            }
          }
        }
      }

      if (delta.new_panes) {
        for (const newPane of delta.new_panes) {
          paneMap.set(newPane.tmux_id, newPane);
        }
      }

      newState.panes = Array.from(paneMap.values());
    }

    // Apply window changes
    if (delta.windows || delta.new_windows) {
      const windowMap = new Map<string, ServerWindow>();
      for (const window of state.windows) {
        windowMap.set(window.id, window);
      }

      if (delta.windows) {
        for (const [windowId, windowDelta] of Object.entries(delta.windows)) {
          if (windowDelta === null) {
            windowMap.delete(windowId);
          } else {
            const existing = windowMap.get(windowId);
            if (existing) {
              windowMap.set(windowId, this.applyWindowDelta(existing, windowDelta));
            }
          }
        }
      }

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
      ...(delta.window_id !== undefined && { window_id: delta.window_id }),
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
      ...(delta.history_size !== undefined && { history_size: delta.history_size }),
      ...(delta.selection_present !== undefined && { selection_present: delta.selection_present }),
      ...(delta.selection_start_x !== undefined && { selection_start_x: delta.selection_start_x }),
      ...(delta.selection_start_y !== undefined && { selection_start_y: delta.selection_start_y }),
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
      ...(delta.is_pane_group_window !== undefined && {
        is_pane_group_window: delta.is_pane_group_window,
      }),
      ...(delta.pane_group_pane_ids !== undefined && {
        pane_group_pane_ids: delta.pane_group_pane_ids,
      }),
    };
  }
}
