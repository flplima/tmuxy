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
import { Effect, Fiber, Queue, Schedule } from 'effect';

/**
 * Reconnection backoff: retry forever, exponential from 1s, capped at 30s.
 *
 * `Schedule.either` recurs while EITHER input recurs and takes the SHORTER of
 * the two delays — so the exponential (1s, 2s, 4s, …) is clamped by the
 * constant 30s spacing, and the constant's infinite recurrence keeps the loop
 * retrying indefinitely until the connection is re-established or the fiber is
 * interrupted. Modelling reconnection as an Effect Schedule (rather than a
 * hand-rolled setTimeout + flag machine) means "keep retrying with backoff"
 * is the schedule's definition — an establish-failure and a mid-session drop
 * are the same program failure, so neither can silently end the retry loop.
 */
const RECONNECT_SCHEDULE = Schedule.exponential('1 seconds').pipe(
  Schedule.either(Schedule.spaced('30 seconds')),
);

/** A connect() caller waiting for the channel to (re)reach the connected state. */
interface ConnectWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
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

/**
 * HTTP Adapter using SSE for server->client push and POST for client->server commands.
 */
export class HttpAdapter implements TmuxAdapter {
  readonly enumeratesSessions = true;
  private eventSource: EventSource | null = null;
  // The supervised reconnect fiber. One Effect.retry loop owns opening the
  // EventSource and reopening it with backoff, so there is never a rival
  // stream to orphan and no hand-maintained timer to forget to reschedule.
  // Null when no channel is running.
  private channelFiber: Fiber.RuntimeFiber<void, never> | null = null;
  // connect() callers waiting for the channel to next reach the connected
  // state. Resolved on connection-info, rejected on fatal / disconnect /
  // session switch — so a connect() issued during a reconnect window waits
  // for the real reconnection instead of resolving against a dead stream.
  private connectWaiters: ConnectWaiter[] = [];
  private readonly reconnectSchedule: Schedule.Schedule<unknown>;
  private connectionId: number = 0;
  private connected = false;
  private reconnecting = false;
  // Session-name override set by switchSession. Instance-scoped (not a module
  // global) so multiple adapters — or a re-created one — don't share/leak it.
  private sessionOverride: string | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;

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
  // Single-flight guard for the delta-seq-gap resync: a live fiber means one is
  // in progress. A fiber (vs. a boolean) can't desync — its finalizer always
  // clears the slot — and it can be interrupted on disconnect.
  private resyncFiber: Fiber.RuntimeFiber<void, never> | null = null;

  // rAF batching: coalesce SSE updates within a single display frame.
  // This prevents "painting" artifacts during full-screen redraws (neovim, etc.)
  // where multiple intermediate states arrive within one frame interval.
  // pendingState holds the latest; rafFiber is the single in-flight frame — a
  // fiber (not a boolean) so its finalizer cancels the rAF on interrupt.
  private pendingState: ServerState | null = null;
  private rafFiber: Fiber.RuntimeFiber<void, never> | null = null;

  // Keyboard batching
  private keyBatcher = new KeyBatcher((cmd, args) => this.sendCommandFireAndForget(cmd, args));

  // Serialized command queue: keystroke and mutating-command POSTs must leave
  // the browser strictly in issue order — concurrent POSTs can arrive reordered,
  // transposing characters or landing a split in the previous tab. Producers
  // offer a task Effect; one consumer fiber (started in the constructor) drains
  // them FIFO, one at a time. Unbounded: the producers are user keystrokes.
  private readonly commandQueue = Effect.runSync(Queue.unbounded<Effect.Effect<void>>());

  /**
   * @param opts.reconnectSchedule override the backoff policy — tests inject a
   *   zero-delay schedule so reconnection is synchronous instead of real-time.
   */
  constructor(opts: { reconnectSchedule?: Schedule.Schedule<unknown> } = {}) {
    this.reconnectSchedule = opts.reconnectSchedule ?? RECONNECT_SCHEDULE;
    // Drain the command queue for the adapter's lifetime: take one task, run it
    // to completion, repeat. Awaiting each task before the next take is what
    // keeps the POSTs serial.
    Effect.runFork(
      Queue.take(this.commandQueue).pipe(
        Effect.flatMap((task) => task.pipe(Effect.ignore)),
        Effect.forever,
      ),
    );
  }

  /** Effective session name: the switchSession override, else the URL param. */
  private getEffectiveSession(): string {
    return this.sessionOverride || getSessionFromUrl();
  }

  connect(): Promise<void> {
    if (this.connected && this.eventSource) return Promise.resolve();
    if (this.fatal)
      return Promise.reject(new Error('tmux backend is in fatal state; refresh required'));

    this.intentionalDisconnect = false;

    // One supervised fiber owns the stream and its reconnect loop. A second
    // caller (e.g. an auto-connect from invoke() during a reconnect window)
    // does NOT open a rival EventSource — it just waits for the same connected
    // transition, so a stream can never be orphaned.
    if (!this.channelFiber) this.startChannel();

    return new Promise<void>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.reconnecting = false;

    this.keyBatcher.destroy();
    this.pendingState = null;
    if (this.rafFiber) {
      Effect.runFork(Fiber.interrupt(this.rafFiber));
      this.rafFiber = null;
    }

    // Interrupt the reconnect fiber; its scoped finalizer closes the stream.
    if (this.channelFiber) {
      Effect.runFork(Fiber.interrupt(this.channelFiber));
      this.channelFiber = null;
    }
    // Drop any in-flight delta-seq-gap resync too.
    if (this.resyncFiber) {
      Effect.runFork(Fiber.interrupt(this.resyncFiber));
      this.resyncFiber = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.connected = false;
    this.connectionId = 0;
    // Nobody is going to connect now — release anyone still awaiting connect().
    this.failConnectWaiters(new Error('disconnected'));
  }

  /**
   * Fork the supervised reconnect loop. `openConnection` fails whenever the
   * stream ends (establish failure OR mid-session drop — the same to the loop),
   * and `Effect.retry` reopens it on the backoff schedule until connected or
   * the fiber is interrupted. A fatal event flips `this.fatal`, which the retry
   * `while` predicate reads to STOP retrying and surface the terminal error to
   * any waiting connect() callers. There is no reschedule call to forget, so
   * the establish-failure dead-loop the old imperative path had is impossible.
   */
  private startChannel(): void {
    // Resolve the events URL here, on the caller's stack, rather than inside the
    // fiber: `window` is only reliably bound synchronously. The URL is fixed for
    // the channel's lifetime (a session change tears the channel down and starts
    // a new one), so reconnect attempts reuse it.
    const session = this.getEffectiveSession();
    const protocol = window.location.protocol;
    const host = window.location.host || 'localhost:3853';
    const eventsUrl = `${protocol}//${host}/events?session=${encodeURIComponent(session)}`;

    const program = this.openConnection(eventsUrl).pipe(
      Effect.retry({ schedule: this.reconnectSchedule, while: () => !this.fatal }),
      // The loop only ends un-interrupted when retrying stops (fatal). Settle
      // any outstanding connect() callers with that terminal error.
      Effect.catchAll((cause) =>
        Effect.sync(() =>
          this.failConnectWaiters(cause instanceof Error ? cause : new Error(String(cause))),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.channelFiber = null;
        }),
      ),
    );
    this.channelFiber = Effect.runFork(program);
  }

  /**
   * Open a single EventSource. The returned effect stays suspended for the
   * LIFETIME of that connection — its handlers fire side effects (notify*,
   * resolve waiters) while connected — and only completes, as a failure, when
   * the connection ends. Retrying it therefore reconnects. Its scoped finalizer
   * closes the stream on interruption (disconnect / session switch).
   */
  private openConnection(eventsUrl: string): Effect.Effect<never, Error> {
    return Effect.async<never, Error>((resume) => {
      const es = new EventSource(eventsUrl);
      this.eventSource = es;

      // End this connection exactly once: close the stream, mark disconnected,
      // announce reconnection (unless intentional/fatal), then fail the effect
      // so the retry schedule takes over.
      let ended = false;
      const endConnection = (error: Error): void => {
        if (ended) return;
        ended = true;
        es.close();
        if (this.eventSource === es) this.eventSource = null;
        this.connected = false;
        this.connectionId = 0;
        if (!this.intentionalDisconnect && !this.fatal) {
          this.reconnecting = true;
          this.reconnectAttempts++;
          this.notifyReconnection(true, this.reconnectAttempts);
        }
        resume(Effect.fail(error));
      };

      es.addEventListener('connection-info', (event: MessageEvent) => {
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
          this.resolveConnectWaiters();
        } catch (e) {
          console.error('Failed to parse connection-info:', e);
        }
      });

      es.addEventListener('state-update', (event: MessageEvent) => {
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
              this.resyncFullState();
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

      es.addEventListener('keybindings', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const keybindings: KeyBindings = data.data || data;
          this.notifyKeyBindings(keybindings);
        } catch (e) {
          console.error('Failed to parse keybindings:', e);
        }
      });

      es.addEventListener('error', (event: MessageEvent) => {
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
      es.addEventListener('clipboard', (event: MessageEvent) => {
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

      es.addEventListener('log', (event: MessageEvent) => {
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

      // Backend gave up reconnecting — terminal state, no more events. Flip the
      // flag the retry `while` predicate checks so the loop stops instead of
      // reconnecting into a dead backend, then end the connection.
      es.addEventListener('fatal', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const message = String((data.data?.message ?? data.message) || 'tmux unavailable');
          this.fatal = true;
          this.notifyFatal(message);
          endConnection(new Error(message));
        } catch (e) {
          console.error('Failed to parse fatal event:', e);
        }
      });

      es.onerror = () => {
        // Establish failure and mid-session drop are the same to the retry
        // loop — end the connection and let the schedule pick the next attempt.
        endConnection(
          new Error(this.connected ? 'SSE connection lost' : 'Failed to connect to SSE'),
        );
      };

      // Interrupt (disconnect / switchSession): close the stream we opened.
      return Effect.sync(() => {
        if (ended) return;
        ended = true;
        es.close();
        if (this.eventSource === es) this.eventSource = null;
      });
    });
  }

  /** Resolve everyone awaiting connect() — a connection-info arrived. */
  private resolveConnectWaiters(): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.resolve();
  }

  /** Reject everyone awaiting connect() (fatal / disconnect / session switch). */
  private failConnectWaiters(reason: unknown): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.reject(reason);
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
    // The task settles the outer promise itself, so its Effect never fails —
    // one task's error can't stall the queue for the next command.
    const task = Effect.promise(() =>
      this.invokeInternal<T>(cmd, args).then(resolveOuter, rejectOuter),
    );
    Effect.runSync(Queue.offer(this.commandQueue, task));
    return outer;
  }

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

    // Offer onto the serial queue so requests go one at a time.
    const task = Effect.promise(() =>
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
    Effect.runSync(Queue.offer(this.commandQueue, task));
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

    // Tear down the current channel fiber (its finalizer closes the stream) so
    // connect() below starts a fresh loop for the new session. Reject anyone
    // still awaiting the old session's connect().
    if (this.channelFiber) {
      Effect.runFork(Fiber.interrupt(this.channelFiber));
      this.channelFiber = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.connectionId = 0;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.failConnectWaiters(new Error('switching session'));

    // Reconnect to new session
    await this.connect();
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
  private resyncFullState(): void {
    if (this.resyncFiber) return; // single-flight: a resync is already running
    if (this.lastCols === 0 || this.lastRows === 0) return;
    const program = Effect.tryPromise({
      try: () =>
        this.invoke<ServerState>('get_initial_state', {
          cols: this.lastCols,
          rows: this.lastRows,
        }),
      catch: (e) => e,
    }).pipe(
      // invoke() already set currentState + reset lastDeltaSeq.
      Effect.flatMap((state) => Effect.sync(() => this.scheduleStateNotify(state))),
      Effect.catchAll((e) =>
        Effect.sync(() =>
          console.error('Delta seq-gap resync failed; awaiting next full snapshot:', e),
        ),
      ),
      // Clear the slot on success, failure, or interruption so the next gap can
      // trigger a fresh resync.
      Effect.ensuring(
        Effect.sync(() => {
          this.resyncFiber = null;
        }),
      ),
    );
    this.resyncFiber = Effect.runFork(program);
  }

  private scheduleStateNotify(state: ServerState): void {
    this.pendingState = state;
    if (this.rafFiber) return; // a frame is already scheduled; latest wins
    const program = Effect.async<void>((resume) => {
      const id = requestAnimationFrame(() => resume(Effect.void));
      // Interrupting the fiber (disconnect) cancels the pending frame.
      return Effect.sync(() => cancelAnimationFrame(id));
    }).pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          const s = this.pendingState;
          this.pendingState = null;
          if (s) this.notifyStateChange(s);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.rafFiber = null;
        }),
      ),
    );
    this.rafFiber = Effect.runFork(program);
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
