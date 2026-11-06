import type { BackendCall } from '../../../domain/backendCalls';
import type { SequencedDriver } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import { StateSequencer } from '../stateSequencer';
import { Effect, Fiber, Schedule } from 'effect';
import {
  buildEndpointUrl,
  ConnectionDropped,
  getSessionFromUrl,
  installNetworkHints,
  openSseConnection,
  postCommandJson,
  postPreviewPage,
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
 * The web's driver: an SSE stream for what the server pushes, one
 * `POST /commands` per call, each under this client's connection id.
 */
export class HttpAdapter implements SequencedDriver {
  readonly enumeratesSessions = true;
  readonly answersQueries = true;
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
  private intentionalDisconnect = false;

  readonly events = new EventHub<DriverEvent>();
  private fatal = false;
  /** Removes the `online` / `visibilitychange` listeners; null while none are installed. */
  private networkHints: (() => void) | null = null;
  /** The in-flight question to a server whose event stream would not open. */
  private refusalProbe: AbortController | null = null;

  /** The client's copy of the state the stream stage sequences; a new connection or session restarts it. */
  readonly sequencer = new StateSequencer();

  /**
   * @param opts.reconnectSchedule override the backoff policy — tests inject a
   *   zero-delay schedule so reconnection is synchronous instead of real-time.
   */
  constructor(opts: { reconnectSchedule?: Schedule.Schedule<unknown> } = {}) {
    this.reconnectSchedule = opts.reconnectSchedule ?? RECONNECT_SCHEDULE;
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
    this.closeChannel(new Error('disconnected'));
  }

  /**
   * Interrupt the reconnect fiber (its scoped finalizer closes the stream)
   * and reject anyone still awaiting connect() with `reason`.
   */
  private closeChannel(reason: Error): void {
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
    this.failConnectWaiters(reason);
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
      onFatal: () => {
        this.fatal = true;
      },
      onEstablishError: (url) => {
        void this.explainRefusal(url);
      },
    });
  }

  /** Ask why the event stream would not open (see probeRefusalReason in httpStream.ts). */
  private async explainRefusal(eventsUrl: string): Promise<void> {
    if (this.refusalProbe || this.fatal) return;
    const probe = new AbortController();
    this.refusalProbe = probe;
    let created = false;
    try {
      const outcome = await probeRefusalReason(
        eventsUrl,
        this.getEffectiveSession(),
        probe.signal,
        () => this.connected,
      );
      if (outcome?.kind === 'created') {
        created = true;
      } else if (outcome) {
        // The attempt that asked has already ended; this stops the next one.
        this.fatal = true;
        this.events.emit(TransportEvent.Fatal({ message: outcome.message }));
      }
    } catch {
      // Unreachable, or aborted below: an outage, which the retry loop owns.
    } finally {
      // A stream that did open is held by the server until aborted.
      probe.abort();
      this.refusalProbe = null;
    }
    if (created) this.reconnectNow();
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

  /**
   * POST `call` under this client's connection id. While the stream is down
   * it waits for it to come back, so a key typed during a reconnect window
   * is posted under the new connection rather than dropped; the wait ends
   * with the stream (`disconnect()` and `switchSession()` fail it).
   */
  async send(call: BackendCall, actionId?: string): Promise<unknown> {
    if (this.intentionalDisconnect) throw new Error('disconnected');
    if (!this.connected) await this.connect();
    return postCommandJson(
      this.getEffectiveSession(),
      this.connectionId,
      call.cmd,
      call.args,
      actionId,
    );
  }

  /** Through the same-origin `/trace` ingest, which a closing page's last batch still reaches. */
  shipTrace(events: Record<string, unknown>[]): void {
    shipTraceBatch(this.connectionId, events);
  }

  /** Bumped per staged page, so each one is a new URL and the frame reloads. */
  private previewVersion = 0;

  async stagePreview(paneId: string, html: string): Promise<string> {
    const path = `/api/preview/${paneId.replace(/^%/, '')}`;
    await postPreviewPage(buildEndpointUrl(path, this.getEffectiveSession()), html);
    return `${buildEndpointUrl(path)}?v=${++this.previewVersion}`;
  }

  async switchSession(newSession: string): Promise<void> {
    this.sessionOverride = newSession;
    this.sequencer.reset();

    // Switching sessions is a fresh start — clear a prior fatal so the switch
    // isn't permanently rejected by connect()'s fatal guard (recovering from a
    // dead session by switching to a live one must be possible without reload).
    this.fatal = false;

    // A fresh loop for the new session; the old session's connect() callers are rejected.
    this.closeChannel(new Error('switching session'));

    // Reconnect to new session
    await this.connect();
  }
}
