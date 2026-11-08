/**
 * The stream stage shared by the HTTP and Tauri transports: raw
 * `state-update` payloads in, decoded and sequenced `State` events out.
 *
 * The server streams a full state then deltas, each against the previous
 * emission and numbered by `seq`. A delta that is missing, misordered or does
 * not decode would apply to the wrong state and silently diverge, so the
 * stage refetches a full state instead (`fetchState` at the last viewport
 * the client reported) — one refetch at a time — and, once the
 * sequencer has adopted it, publishes the sequencer's state in turn. Every
 * other event passes through in order.
 */

import { Chunk, Effect, FiberSet, Option, PubSub, Queue, type Scope, Stream } from 'effect';
import type { ServerState } from '../../domain/wire';
import { formatAdapterError, type AdapterError } from './AdapterError';
import { latencyTracker } from '../latencyTracker';
import type { StateSequencer } from './stateSequencer';
import { tracer } from '../tracer';
import type { SequencedDriver } from './driver';
import { type DriverEvent, TransportEvent } from './events';
import {
  forwardDriverEvents,
  openEventPubSub,
  serviceOver,
  type TmuxTransportService,
} from './TmuxTransport';

/** A refetched full state has been adopted: publish the sequencer's state from here. */
const RESYNCED = { _tag: 'Resynced' } as const;

/** What the stream stage reads: the driver's events, and its own `RESYNCED` marks. */
export type FeedEvent = DriverEvent | typeof RESYNCED;

/**
 * Sequence the raw states on `feed`. `resync` refetches a full state (already
 * adopted by `sequencer`), or None when it cannot yet. A delta that arrives
 * while the refetch is out is held by the sequencer, never published, and
 * starts no second refetch. Once the answer is adopted, a mark goes on the
 * back of `feed`: the state published there is the sequencer's at that point
 * — the answer, the held deltas above its number, and any delta queued ahead
 * of the mark — so the answer alone is never painted over something newer.
 * A hole among the held deltas leaves the sequencer diverged, and the mark
 * asks for the one more refetch that loss needs.
 */
export const sequenceStateUpdates = (
  feed: Queue.Queue<FeedEvent>,
  sequencer: StateSequencer,
  resync: Effect.Effect<Option.Option<ServerState>, AdapterError>,
): Effect.Effect<Stream.Stream<TransportEvent>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const oneAtATime = yield* Effect.makeSemaphore(1);
    const fork = yield* FiberSet.makeRuntime<never>();
    const refetch = oneAtATime.withPermitsIfAvailable(1)(
      resync.pipe(
        Effect.flatMap((answer) =>
          Option.isSome(answer) ? Queue.offer(feed, RESYNCED) : Effect.void,
        ),
        Effect.catchAll((e) =>
          Effect.sync(() =>
            console.error(
              'Delta seq-gap resync failed; awaiting next full snapshot:',
              formatAdapterError(e),
            ),
          ),
        ),
      ),
    );
    const sequence = (event: FeedEvent): Option.Option<TransportEvent> => {
      if (event._tag !== 'StateReceived' && event._tag !== 'Resynced') return Option.some(event);
      const step =
        event._tag === 'Resynced' ? sequencer.current() : sequencer.receive(event.payload);
      if (step._tag === 'State') return Option.some(step);
      if (step._tag === 'Resync') fork(refetch);
      return Option.none();
    };
    return Stream.fromQueue(feed).pipe(
      Stream.mapChunks((chunk) => Chunk.filterMap(chunk, sequence)),
    );
  });

/**
 * Coalesce states to one per display frame, the latest winning. During a
 * full-screen redraw (neovim, …) several partial states arrive within one
 * frame; painting only the last removes the visible "painting" effect. Other
 * events pass straight through.
 */
export const latestStatePerFrame = (
  self: Stream.Stream<TransportEvent>,
): Stream.Stream<TransportEvent> =>
  Stream.asyncPush<TransportEvent>(
    (emit) =>
      Effect.gen(function* () {
        let pending: TransportEvent | null = null;
        let frame: number | null = null;
        const paint = (): void => {
          frame = null;
          const state = pending;
          pending = null;
          if (state) emit.single(state);
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (frame !== null) cancelAnimationFrame(frame);
          }),
        );
        yield* self.pipe(
          Stream.runForEachChunk((chunk) =>
            Effect.sync(() => {
              for (const event of chunk) {
                if (event._tag !== 'State') {
                  emit.single(event);
                  continue;
                }
                pending = event;
                frame ??= requestAnimationFrame(paint);
              }
            }),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 'unbounded' },
  );

/** The paint-bound apply: closes the oldest input's round trip (Axis-B) and joins the trace. */
function recordApplied(event: TransportEvent): void {
  if (event._tag !== 'State') return;
  latencyTracker.recordUpdate();
  tracer.event({ layer: 'adapter', name: 'apply', seq: event.seq ?? undefined });
}

/**
 * The service over a driver that streams deltas: its events go through
 * `sequenceStateUpdates` (and, on the web, `latestStatePerFrame`) before they
 * are published, and a fetched full state is adopted by the same sequencer
 * so later deltas apply to it. A refetch asks for the viewport the client
 * last reported.
 */
export const makeSequencedTransport = (
  driver: SequencedDriver,
  options: { readonly latestPerFrame: boolean },
): Effect.Effect<TmuxTransportService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sequencer } = driver;
    const feed = yield* Queue.unbounded<FeedEvent>();
    yield* forwardDriverEvents(driver, (event) => {
      feed.unsafeOffer(event);
    });
    const pubsub = yield* openEventPubSub;
    const { service, viewport } = serviceOver(driver, pubsub, {
      adoptState: (raw) => sequencer.adopt(raw),
      streamPosition: () => sequencer.position(),
    });

    const resync = Effect.suspend(() => {
      const size = viewport();
      return size === null || size.cols === 0 || size.rows === 0
        ? Effect.succeedNone
        : Effect.asSome(service.fetchState(size));
    });

    const sequenced = yield* sequenceStateUpdates(feed, sequencer, resync);
    yield* (options.latestPerFrame ? latestStatePerFrame(sequenced) : sequenced).pipe(
      Stream.runForEachChunk((chunk) => {
        Chunk.forEach(chunk, recordApplied);
        return PubSub.publishAll(pubsub, chunk);
      }),
      Effect.forkScoped,
    );
    return service;
  });
