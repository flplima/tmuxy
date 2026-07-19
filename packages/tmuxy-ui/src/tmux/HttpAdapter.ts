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
import { handleStateUpdate, isDeltaSeqGap } from './deltaProtocol';
import { KeyBatcher } from './keyBatching';
import { latencyTracker } from './latencyTracker';

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
 * HTTP Adapter using SSE for server->client push and POST for client->server commands.
 */
export class HttpAdapter implements TmuxAdapter {
  readonly enumeratesSessions = true;
  private eventSource: EventSource | null = null;
  // In-flight connect(): a reconnect timer and an auto-connect from invoke()
  // can both call connect() while `connected` is false. Without deduping, the
  // second opens a second EventSource that overwrites `this.eventSource`,
  // orphaning the first (open, all listeners attached, never closable).
  private connectPromise: Promise<void> | null = null;
  private connectionId: number = 0;
  private connected = false;
  private reconnecting = false;
  // Session-name override set by switchSession. Instance-scoped (not a module
  // global) so multiple adapters — or a re-created one — don't share/leak it.
  private sessionOverride: string | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();
  private logListeners = new Set<LogListener>();
  private fatalListeners = new Set<FatalListener>();
  private clipboardListeners = new Set<ClipboardListener>();
  private fatal = false;

  // Delta protocol state
  private currentState: ServerState | null = null;
  // Last applied delta seq (null right after a full snapshot). Used to detect a
  // dropped/misordered delta and refetch a full state before it diverges.
  private lastDeltaSeq: number | null = null;
  // Last client size seen via set_client_size/get_initial_state — needed to
  // refetch a full snapshot on a seq gap (get_initial_state takes cols/rows).
  private lastCols = 0;
  private lastRows = 0;
  private resyncing = false;

  // rAF batching: coalesce SSE updates within a single display frame.
  // This prevents "painting" artifacts during full-screen redraws (neovim, etc.)
  // where multiple intermediate states arrive within one frame interval.
  private pendingState: ServerState | null = null;
  private rafScheduled = false;

  // Keyboard batching
  private keyBatcher = new KeyBatcher((cmd, args) => this.sendCommandFireAndForget(cmd, args));

  /** Effective session name: the switchSession override, else the URL param. */
  private getEffectiveSession(): string {
    return this.sessionOverride || getSessionFromUrl();
  }

  connect(): Promise<void> {
    if (this.connected && this.eventSource) return Promise.resolve();
    if (this.fatal)
      return Promise.reject(new Error('tmux backend is in fatal state; refresh required'));
    // A connect is already in flight — reuse it instead of opening a rival
    // EventSource (see connectPromise above).
    if (this.connectPromise) return this.connectPromise;

    this.intentionalDisconnect = false;

    // Defensively close any lingering stream before opening a new one, so a
    // path that reached here with a half-open EventSource can't leak it.
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const pending = new Promise<void>((resolve, reject) => {
      const session = this.getEffectiveSession();
      const protocol = window.location.protocol;
      const host = window.location.host || 'localhost:3853';
      const eventsUrl = `${protocol}//${host}/events?session=${encodeURIComponent(session)}`;

      this.eventSource = new EventSource(eventsUrl);

      this.eventSource.addEventListener('connection-info', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.connectionId = data.data?.connection_id ?? data.connection_id ?? 0;
          this.connected = true;
          this.reconnectAttempts = 0;

          // Clear reconnecting state if was reconnecting
          if (this.reconnecting) {
            this.reconnecting = false;
            this.notifyReconnection(false, 0);
          }

          const defaultShell = data.data?.default_shell ?? data.default_shell ?? 'bash';
          this.notifyConnectionInfo(this.connectionId, defaultShell);
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

          // Delta seq-gap detection: a dropped or misordered delta would
          // otherwise apply to stale state and silently diverge. On a gap,
          // refetch a full snapshot instead of applying the delta.
          if (update.type === 'delta') {
            if (isDeltaSeqGap(this.lastDeltaSeq, update.delta)) {
              this.lastDeltaSeq = null;
              void this.resyncFullState();
              return;
            }
            this.lastDeltaSeq = update.delta.seq;
          } else {
            // A full snapshot is a fresh sync point.
            this.lastDeltaSeq = null;
          }

          const newState = handleStateUpdate(update, this.currentState);
          if (newState) {
            this.currentState = newState;
            this.scheduleStateNotify(newState);
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

      // OSC 52 clipboard write requests from terminal applications.
      // Mirrored into the system clipboard via navigator.clipboard.writeText.
      this.eventSource.addEventListener('clipboard', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const payload = data.data || data;
          const paneId = String(payload.pane_id ?? '');
          const text = String(payload.text ?? '');
          this.notifyClipboard(paneId, text);
        } catch (e) {
          console.error('Failed to parse clipboard event:', e);
        }
      });

      this.eventSource.addEventListener('log', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const payload = data.data || data;
          const kind = (payload.kind as LogEntryKind) || 'info';
          const message = String(payload.message ?? '');
          this.notifyLog(kind, message);
        } catch (e) {
          console.error('Failed to parse log event:', e);
        }
      });

      // Backend gave up reconnecting — terminal state, no more events. Suppress
      // EventSource auto-reconnect so the UI surfaces the error instead of a
      // silent retry storm.
      this.eventSource.addEventListener('fatal', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const message = String((data.data?.message ?? data.message) || 'tmux unavailable');
          this.fatal = true;
          this.intentionalDisconnect = true;
          this.connected = false;
          this.reconnecting = false;
          if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
          }
          this.notifyFatal(message);
          // If fatal arrives as the first event (before connection-info), the
          // connect() promise would otherwise never settle and — now that it's
          // cached in connectPromise — wedge every future connect(). Reject it;
          // a no-op if connection-info already resolved it.
          reject(new Error(message));
        } catch (e) {
          console.error('Failed to parse fatal event:', e);
        }
      });

      this.eventSource.onerror = () => {
        if (!this.connected) {
          // Connection failed to establish — close the EventSource to prevent
          // the browser's built-in auto-reconnection from creating a storm of
          // server-side connections and monitor spawns.
          if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
          }
          this.notifyError('Failed to connect to SSE');
          reject(new Error('Failed to connect to SSE'));
          return;
        }

        // Connection lost - attempt reconnect
        this.connected = false;
        this.connectionId = 0;

        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }

        if (!this.intentionalDisconnect) {
          this.attemptReconnect();
        }
      };
    });

    // Clear the in-flight marker once settled so the next connect() (after a
    // drop) can start fresh. On success `connected` is already true, so the
    // early-return above short-circuits before this matters. The identity
    // check avoids a stale settle (from a forcibly-torn-down connect) nulling
    // a newer connect's marker.
    const chained = pending.finally(() => {
      if (this.connectPromise === chained) this.connectPromise = null;
    });
    this.connectPromise = chained;
    return chained;
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

    this.pendingState = null;
    this.rafScheduled = false;

    // Abandon any in-flight connect so a later reconnect starts fresh.
    this.connectPromise = null;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.connected = false;
    this.connectionId = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return this.reconnecting;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    // Cache the client size so a seq-gap resync can refetch get_initial_state.
    if (
      (cmd === 'set_client_size' || cmd === 'get_initial_state') &&
      typeof args?.cols === 'number' &&
      typeof args?.rows === 'number'
    ) {
      this.lastCols = args.cols;
      this.lastRows = args.rows;
    }

    // Special handling for get_initial_state: also set currentState so delta updates work
    if (cmd === 'get_initial_state') {
      const result = await this.invokeInternal<T>(cmd, args);
      this.currentState = result as ServerState;
      this.lastDeltaSeq = null;
      return result;
    }

    // Check if this is a send-keys command that should be batched
    if (this.keyBatcher.intercept(cmd, args)) {
      return Promise.resolve(undefined as T);
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.keyBatcher.flushAll();

    // run_tmux_command is a mutating call that MUST reach the monitor's
    // command channel in issue order. axum spawns each POST as its own task,
    // so two concurrent invokes can call `tx.send()` in the reverse order
    // they were issued from the frontend — and a `split-window -h` that
    // raced past a `select-window -t @B` would split the previous tab. Chain
    // through `sendQueue` so HTTP POSTs leave the browser one at a time.
    if (cmd === 'run_tmux_command') {
      latencyTracker.markInput();
      return this.enqueueSerialInvoke<T>(cmd, args);
    }

    return this.invokeInternal(cmd, args);
  }

  /**
   * Read-only tmux query that bypasses the mutation serial queue (see
   * TmuxAdapter.queryReadonly). The server runs these as one-off subprocesses
   * that return stdout; ordering them against mutations only adds latency.
   */
  queryReadonly(command: string): Promise<string> {
    return this.invokeInternal<string>('run_tmux_command', { command });
  }

  /**
   * Chain an invoke onto the serial sendQueue so it runs only after every
   * earlier mutating command has completed its POST. Errors are caught on
   * the queue chain so a single failure doesn't deadlock subsequent commands,
   * but they're re-thrown on the returned promise so the caller still sees
   * them.
   */
  private enqueueSerialInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    let resolveOuter!: (value: T | PromiseLike<T>) => void;
    let rejectOuter!: (reason: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        const result = await this.invokeInternal<T>(cmd, args);
        resolveOuter(result);
      } catch (err) {
        rejectOuter(err);
      }
    });
    return outer;
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
    if (!this.connected) {
      console.warn('[HttpAdapter] Not connected, cannot send command');
      return;
    }

    // Keystrokes are the latency-critical input path — mark the round-trip so
    // the next applied state update closes it (Axis-B, see latencyTracker).
    latencyTracker.markInput();

    const session = this.getEffectiveSession();
    const protocol = window.location.protocol;
    const host = window.location.host || 'localhost:3853';
    const commandsUrl = `${protocol}//${host}/commands?session=${encodeURIComponent(session)}`;
    const connId = String(this.connectionId);

    // Chain onto the serial queue so requests go one at a time
    this.sendQueue = this.sendQueue.then(() =>
      fetch(commandsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connection-Id': connId,
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
    if (!this.connected) {
      await this.connect();
    }

    const session = this.getEffectiveSession();
    const protocol = window.location.protocol;
    const host = window.location.host || 'localhost:3853';
    const commandsUrl = `${protocol}//${host}/commands?session=${encodeURIComponent(session)}`;

    const response = await fetch(commandsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': String(this.connectionId),
      },
      body: JSON.stringify({ cmd, args: args || {} }),
    });

    if (!response.ok) {
      // A non-JSON error body — a reverse-proxy 502 page, a 401 auth
      // challenge — must surface as the HTTP status, not a JSON SyntaxError
      // from parsing HTML. Try for a structured {error}, fall back to status.
      let message = `HTTP ${response.status}`;
      try {
        const errData = await response.json();
        if (errData?.error) message = errData.error;
      } catch {
        // Non-JSON body: keep the HTTP status message.
      }
      throw new Error(message);
    }

    const data = await response.json();
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

  async switchSession(newSession: string): Promise<void> {
    this.sessionOverride = newSession;
    this.currentState = null;
    this.lastDeltaSeq = null;

    // Switching sessions is a fresh start — clear a prior fatal so the switch
    // isn't permanently rejected by connect()'s fatal guard (recovering from a
    // dead session by switching to a live one must be possible without reload).
    this.fatal = false;

    // Abandon any in-flight connect to the old session so connect() below
    // opens a fresh stream for the new session instead of reusing it.
    this.connectPromise = null;

    // Close current connection without marking as intentional disconnect
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.connectionId = 0;

    // Reconnect to new session
    await this.connect();
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

  /**
   * Coalesce SSE updates within a single display frame via requestAnimationFrame.
   * During full-screen redraws (neovim, etc.), the backend emits multiple partial
   * states within one 16.67ms display frame. rAF batching ensures only the final
   * (most complete) state is rendered, eliminating the visible "painting" effect.
   */
  /**
   * Refetch a full state snapshot after a delta seq gap. Uses the last client
   * size seen via set_client_size/get_initial_state; if none has been seen yet,
   * skips (the server's periodic full snapshot recovers). Guarded so overlapping
   * gaps trigger a single refetch.
   */
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
      this.scheduleStateNotify(state);
    } catch (e) {
      console.error('Delta seq-gap resync failed; awaiting next full snapshot:', e);
    } finally {
      this.resyncing = false;
    }
  }

  private scheduleStateNotify(state: ServerState): void {
    this.pendingState = state;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => {
        this.rafScheduled = false;
        const s = this.pendingState;
        this.pendingState = null;
        if (s) this.notifyStateChange(s);
      });
    }
  }

  private notifyStateChange(state: ServerState): void {
    // Paint-bound apply (rAF-batched): closes the oldest outstanding input's
    // round trip and feeds the update-rate / stall metrics (Axis-B).
    latencyTracker.recordUpdate();
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

  private notifyLog(kind: LogEntryKind, message: string): void {
    this.logListeners.forEach((listener) => listener(kind, message));
  }

  private notifyFatal(message: string): void {
    this.fatalListeners.forEach((listener) => listener(message));
  }

  private notifyClipboard(paneId: string, text: string): void {
    this.clipboardListeners.forEach((listener) => listener(paneId, text));
  }
}
