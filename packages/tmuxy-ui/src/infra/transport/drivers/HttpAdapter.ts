import type { BackendCall } from '../../../domain/backendCalls';
import type { SequencedDriver } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import { StateSequencer } from '../stateSequencer';
import { Effect, Fiber, Schedule } from 'effect';
import { buildEndpointUrl, getSessionFromUrl } from '../endpoint';
import {
  ConnectionDropped,
  installNetworkHints,
  openSseConnection,
  postCommandJson,
  postCommandsLost,
  postPreviewPage,
  probeRefusalReason,
  RECONNECT_SCHEDULE,
  REOPEN_AFTER_DROP_MS,
  shipTraceBatch,
} from './httpStream';

/** How many lost numbers one POST names; the server reads no more. */
const LOST_SEQS_PER_POST = 64;

interface ConnectWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * The web's driver: an SSE stream for what the server pushes, one
 * `POST /commands` per call, each under this client's connection id. The
 * lane's calls are pipelined: each is numbered and posted without waiting
 * for the one before, and the server runs them in number order.
 */
export class HttpAdapter implements SequencedDriver {
  readonly enumeratesSessions = true;
  readonly answersQueries = true;
  readonly ordersSends = true;
  /** The number of the last ordered call posted under `connectionId`. */
  private commandSeq = 0;
  /**
   * Numbers posted under `connectionId` that failed with no answer. Each
   * later ordered POST names them until one is answered, so the server does
   * not hold the commands after them waiting for one that is not coming.
   */
  private lostSeqs: number[] = [];
  /** Settles when the ordered call before the next one has been numbered. */
  private numbered: Promise<void> = Promise.resolve();
  private eventSource: EventSource | null = null;
  // The one loop that opens the EventSource and reopens it with backoff;
  // null when no channel is running.
  private channelFiber: Fiber.RuntimeFiber<void, never> | null = null;
  // Resolved on connection-info, rejected on fatal / disconnect / session
  // switch: a connect() issued during a reconnect window waits for the real
  // reconnection instead of resolving against a dead stream.
  private connectWaiters: ConnectWaiter[] = [];
  private readonly reconnectSchedule: Schedule.Schedule<unknown>;
  private connectionId: number = 0;
  private connected = false;
  private reconnecting = false;
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

  constructor(opts: { reconnectSchedule?: Schedule.Schedule<unknown> } = {}) {
    this.reconnectSchedule = opts.reconnectSchedule ?? RECONNECT_SCHEDULE;
  }

  private getEffectiveSession(): string {
    return this.sessionOverride || getSessionFromUrl();
  }

  connect(): Promise<void> {
    if (this.connected && this.eventSource) return Promise.resolve();
    if (this.fatal)
      return Promise.reject(new Error('tmux backend is in fatal state; refresh required'));

    this.intentionalDisconnect = false;

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

  private startChannel(): void {
    // Resolved on the caller's stack, not inside the fiber: `window` is only
    // reliably bound synchronously.
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
        // The server counts each connection's commands from 1.
        this.commandSeq = 0;
        this.lostSeqs = [];
        this.connected = true;

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

  private resolveConnectWaiters(): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.resolve();
  }

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
   *
   * An `ordered` call takes the connection's next number once every ordered
   * call before it has taken its own, and is then posted at once: the wait
   * is for the stream at most, never for an answer.
   */
  async send(call: BackendCall, actionId?: string, ordered = false): Promise<unknown> {
    const online = async () => {
      if (this.intentionalDisconnect) throw new Error('disconnected');
      if (!this.connected) await this.connect();
    };
    const post = (seq?: number) => {
      const connection = this.connectionId;
      const base = [this.getEffectiveSession(), connection, call.cmd, call.args, actionId] as const;
      if (seq === undefined) return postCommandJson(...base);
      const lost = this.lostSeqs.slice(0, LOST_SEQS_PER_POST);
      let answered = false;
      const answer = postCommandJson(...base, {
        seq,
        lost,
        onAnswered: () => {
          answered = true;
          if (this.connectionId !== connection) return;
          this.lostSeqs = this.lostSeqs.filter((n) => !lost.includes(n));
        },
      });
      // Reported by `answer` to the caller; the next call only needs to know
      // whether the server ever saw this number.
      answer.catch(() => {
        if (answered || this.connectionId !== connection) return;
        this.lostSeqs.push(seq);
        void this.reportLost(connection);
      });
      return answer;
    };
    if (!ordered) {
      await online();
      return post();
    }
    let answer: Promise<unknown> | undefined;
    const turn = this.numbered.then(async () => {
      await online();
      answer = post(++this.commandSeq);
    });
    this.numbered = turn.catch(() => undefined);
    await turn;
    return answer;
  }

  /**
   * Say now which numbers were lost: commands posted after them may already
   * wait at the server, and if the user stops typing no later POST names
   * them. Unheard, they stay listed for the next ordered POST.
   */
  private async reportLost(connection: number): Promise<void> {
    const lost = this.lostSeqs.slice(0, LOST_SEQS_PER_POST);
    const heard = await postCommandsLost(this.getEffectiveSession(), connection, lost);
    if (!heard || this.connectionId !== connection) return;
    this.lostSeqs = this.lostSeqs.filter((n) => !lost.includes(n));
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

    // Recovering from a dead session by switching to a live one must work
    // without a reload, so a prior fatal is cleared.
    this.fatal = false;

    // A fresh loop for the new session; the old session's connect() callers are rejected.
    this.closeChannel(new Error('switching session'));

    await this.connect();
  }
}
