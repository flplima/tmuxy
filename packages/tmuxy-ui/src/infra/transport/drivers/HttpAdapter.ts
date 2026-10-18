import type { SequencedAdapter } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import { StateSequencer } from '../stateSequencer';
import { KeyBatcher } from '../keyBatching';
import { latencyTracker } from '../../latencyTracker';
import { tracer } from '../../tracer';
import { isReadCommand, READ_ONLY_REASON } from '../../../domain/readOnly';
import { Cancelled } from '../AdapterError';
import { Effect, Fiber, Queue, Schedule } from 'effect';
import {
  buildEndpointUrl,
  ConnectionDropped,
  getSessionFromUrl,
  installNetworkHints,
  openSseConnection,
  postCommandFireAndForgetEffect,
  postCommandJson,
  probeRefusalReason,
  RECONNECT_SCHEDULE,
  REOPEN_AFTER_DROP_MS,
  shipTraceBatch,
} from './httpStream';

/** A connect() caller waiting for the channel to (re)reach the connected state. */
interface ConnectWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * HTTP Adapter using SSE for server->client push and POST for client->server commands.
 */
export class HttpAdapter implements SequencedAdapter {
  /** The server runs `--read-only`; known from the `connection-info` greeting. */
  readOnly = false;
  /** Enumerating sessions is a `query_tmux`, which a read-only server refuses. */
  get enumeratesSessions(): boolean {
    return !this.readOnly;
  }
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
  /** Per-connection counter for minting trace action ids (docs/TELEMETRY.md). */
  private traceActionSeq = 0;
  private reconnecting = false;
  // Session-name override set by switchSession. Instance-scoped (not a module
  // global) so multiple adapters — or a re-created one — don't share/leak it.
  private sessionOverride: string | null = null;
  private intentionalDisconnect = false;

  readonly events = new EventHub<DriverEvent>();
  private fatal = false;
  /** Removes the `online` / `visibilitychange` listeners; null while none are installed. */
  private networkHints: (() => void) | null = null;
  /** The in-flight question to a server whose event stream would not open. */
  private refusalProbe: AbortController | null = null;

  /** The client's copy of the state the stream stage sequences; a new connection or session restarts it. */
  readonly sequencer = new StateSequencer();

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
    if (!this.networkHints) {
      this.networkHints = installNetworkHints(() => this.reconnectNow());
    }

    return new Promise<void>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.networkHints?.();
    this.networkHints = null;
    this.reconnecting = false;

    this.keyBatcher.destroy();

    // Interrupt the reconnect fiber; its scoped finalizer closes the stream.
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
    const eventsUrl = buildEndpointUrl('/events', this.getEffectiveSession());

    // The backoff belongs to ONE outage. A connection that was established and
    // then dropped leaves the retry (`while` turns false for it) and the loop
    // comes round to a fresh schedule — one `Effect.retry` for the channel's
    // whole life only ever climbs, so after a handful of sleep/wake cycles
    // every reconnect waited out the 30s cap however briefly the link was down.
    const oneOutage = this.openConnection(eventsUrl).pipe(
      Effect.retry({
        schedule: this.reconnectSchedule,
        while: (cause) => !this.fatal && !(cause instanceof ConnectionDropped),
      }),
      Effect.catchIf(
        (cause) => cause instanceof ConnectionDropped && !this.fatal,
        () => Effect.sleep(`${REOPEN_AFTER_DROP_MS} millis`),
      ),
    );
    const program = oneOutage.pipe(
      Effect.forever,
      // The loop only ends un-interrupted when retrying stops (fatal). Settle
      // any outstanding connect() callers with that terminal error.
      Effect.catchAll((cause) =>
        Effect.sync(() =>
          this.failConnectWaiters(cause instanceof Error ? cause : new Error(String(cause))),
        ),
      ),
    );
    const fiber = Effect.runFork(program);
    this.channelFiber = fiber;
    // Only while it is still the current one: `reconnectNow` replaces the
    // fiber, and the old one ending must not clear its successor's slot.
    fiber.addObserver(() => {
      if (this.channelFiber === fiber) this.channelFiber = null;
    });
  }

  /**
   * Stop waiting out the backoff and try again now. Called when there is a
   * reason to think the network is back — the browser says so (`online`), the
   * tab came to the front, the user pressed Retry — because none of those reach
   * a fiber asleep for up to 30s. A no-op while connected, fatal or stopped.
   */
  reconnectNow(): void {
    if (this.connected || this.fatal || this.intentionalDisconnect || !this.channelFiber) return;
    Effect.runFork(Fiber.interrupt(this.channelFiber));
    this.startChannel();
  }

  private openConnection(eventsUrl: string): Effect.Effect<never, Error> {
    return openSseConnection(eventsUrl, {
      events: this.events,
      onOpen: (es) => {
        // A new connection starts a new sequence; until its full state lands,
        // an initial-state answer is the state to start from.
        this.sequencer.reopen();
        this.eventSource = es;
      },
      onClose: (es) => {
        if (this.eventSource === es) this.eventSource = null;
      },
      isConnected: () => this.connected,
      isStopRetrying: () => this.intentionalDisconnect || this.fatal,
      onConnected: (data) => {
        this.connectionId = data.connection_id;
        this.connected = true;

        // Clear reconnecting state if was reconnecting
        if (this.reconnecting) {
          this.reconnecting = false;
          this.events.emit(TransportEvent.Reconnection({ reconnecting: false }));
        }

        this.readOnly = data.read_only === true;
        this.events.emit(
          TransportEvent.ConnectionInfo({
            defaultShell: data.default_shell ?? 'bash',
            readOnly: this.readOnly,
          }),
        );

        this.resolveConnectWaiters();
      },
      onDisconnected: (shouldAnnounceReconnect) => {
        this.connected = false;
        this.connectionId = 0;
        if (shouldAnnounceReconnect) {
          this.reconnecting = true;
          this.events.emit(TransportEvent.Reconnection({ reconnecting: true }));
        }
      },
      onFatal: (message) => {
        this.fatal = true;
        this.events.emit(TransportEvent.Fatal({ message }));
      },
      onEstablishError: (url) => {
        void this.explainRefusal(url);
      },
      shipTrace: (events) => shipTraceBatch(this.connectionId, events),
    });
  }

  /** Ask why the event stream would not open (see probeRefusalReason in httpStream.ts). */
  private async explainRefusal(eventsUrl: string): Promise<void> {
    if (this.refusalProbe || this.fatal) return;
    const probe = new AbortController();
    this.refusalProbe = probe;
    try {
      const message = await probeRefusalReason(eventsUrl, probe.signal, () => this.connected);
      if (!message) return;
      // The attempt that asked has already ended; this stops the next one.
      this.fatal = true;
      this.events.emit(TransportEvent.Fatal({ message }));
    } catch {
      // Unreachable, or aborted below: an outage, which the retry loop owns.
    } finally {
      // A stream that did open is held by the server until aborted.
      probe.abort();
      this.refusalProbe = null;
    }
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

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (this.readOnly) {
      if (!isReadCommand(cmd)) throw new Cancelled({ reason: READ_ONLY_REASON });
      // A viewer never reports its viewport: the session is sized to its
      // smallest client, and that would shrink it under whoever writes.
      if (cmd === 'get_initial_state') args = {};
    }

    // Answered raw: the stream stage decodes and adopts it.
    if (cmd === 'get_initial_state') return this.invokeInternal(cmd, args);

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
      const actionId = tracer.isEnabled() ? this.nextActionId() : undefined;
      tracer.event({ layer: 'adapter', name: 'send', kind: 'command', action_id: actionId });
      return this.enqueueSerialInvoke<T>(cmd, args, actionId);
    }

    return this.invokeInternal(cmd, args);
  }

  /**
   * Read from tmux (see TmuxAdapter.query). Not chained onto the mutation
   * serial queue: the server answers it in-band on the same connection the
   * mutations use, so tmux itself keeps the order.
   */
  query(command: string): Promise<string> {
    if (this.readOnly) return Promise.reject(new Cancelled({ reason: READ_ONLY_REASON }));
    return this.invokeInternal<string>('query_tmux', { command });
  }

  /**
   * Chain an invoke onto the serial sendQueue so it runs only after every
   * earlier mutating command has completed its POST. Errors are caught on
   * the queue chain so a single failure doesn't deadlock subsequent commands,
   * but they're re-thrown on the returned promise so the caller still sees
   * them.
   */
  private enqueueSerialInvoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
    actionId?: string,
  ): Promise<T> {
    let resolveOuter!: (value: T | PromiseLike<T>) => void;
    let rejectOuter!: (reason: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    // The task settles the outer promise itself, so its Effect never fails —
    // one task's error can't stall the queue for the next command.
    const task = Effect.promise(() =>
      this.invokeInternal<T>(cmd, args, actionId).then(resolveOuter, rejectOuter),
    );
    this.commandQueue.unsafeOffer(task);
    return outer;
  }

  /**
   * Send a command in order (serialized, but caller doesn't await)
   */
  private sendCommandFireAndForget(cmd: string, args: Record<string, unknown>): void {
    if (this.readOnly) return;
    if (!this.connected) {
      console.warn('[HttpAdapter] Not connected, cannot send command');
      return;
    }

    // Keystrokes are the latency-critical input path — mark the round-trip so
    // the next applied state update closes it (Axis-B, see latencyTracker).
    latencyTracker.markInput();
    const actionId = tracer.isEnabled() ? this.nextActionId() : undefined;
    tracer.event({ layer: 'adapter', name: 'send', kind: 'keys', action_id: actionId });

    // Offer onto the serial queue so requests go one at a time.
    this.commandQueue.unsafeOffer(
      postCommandFireAndForgetEffect(
        this.getEffectiveSession(),
        this.connectionId,
        cmd,
        args,
        actionId,
      ),
    );
  }

  /**
   * Internal invoke implementation
   */
  private async invokeInternal<T>(
    cmd: string,
    args?: Record<string, unknown>,
    actionId?: string,
  ): Promise<T> {
    if (!this.connected) {
      await this.connect();
    }

    return postCommandJson<T>(this.getEffectiveSession(), this.connectionId, cmd, args, actionId);
  }

  async switchSession(newSession: string): Promise<void> {
    this.sessionOverride = newSession;
    this.sequencer.reset();

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
    this.failConnectWaiters(new Error('switching session'));

    // Reconnect to new session
    await this.connect();
  }

  /** Mint a per-connection action id (e.g. `a-3-17`) so the trace can correlate
   * a command's request leg from client send to server receive. */
  private nextActionId(): string {
    this.traceActionSeq += 1;
    return `a-${this.connectionId}-${this.traceActionSeq}`;
  }
}
