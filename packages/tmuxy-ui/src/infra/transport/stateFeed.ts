/**
 * The stream stage shared by the HTTP and Tauri transports: raw
 * `state-update` payloads in, decoded and sequenced `State` events out.
 *
 * The server streams a full state then deltas, each against the previous
 * emission and numbered by `seq`. A delta that is missing, misordered or does
 * not decode would apply to the wrong state and silently diverge, so the
 * stage refetches a full state instead (`get_initial_state` at the last
 * viewport the client reported) — one refetch at a time — and puts the answer
 * back on the feed. Every other event passes through in order.
 */

import { Chunk, Effect, FiberSet, Option, PubSub, Queue, type Scope, Stream } from 'effect';
import type { ServerState } from '../../domain/wire';
import { classifyAdapterError, formatAdapterError } from './AdapterError';
import type { AdapterError } from './AdapterError';
import { latencyTracker } from '../latencyTracker';
import type { StateSequencer } from './stateSequencer';
import { tracer } from '../tracer';
import type { SequencedAdapter } from './driver';
import { type DriverEvent, TransportEvent } from './events';
import {
  forwardDriverEvents,
  openEventPubSub,
  serviceOver,
  type TmuxTransportService,
} from './TmuxTransport';

/**
 * Sequence the raw states on `feed`. `resync` refetches a full state (already
 * adopted by `sequencer`), or None when it cannot yet; its answer is offered
 * back onto `feed` so it is published in turn.
 */
export const sequenceStateUpdates = (
  feed: Queue.Queue<DriverEvent>,
  sequencer: StateSequencer,
  resync: Effect.Effect<Option.Option<ServerState>, AdapterError>,
): Effect.Effect<Stream.Stream<TransportEvent>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const oneAtATime = yield* Effect.makeSemaphore(1);
    const fork = yield* FiberSet.makeRuntime<never>();
    const refetch = oneAtATime.withPermitsIfAvailable(1)(
      resync.pipe(
        Effect.flatMap((answer) =>
          Option.isSome(answer)
            ? Queue.offer(feed, TransportEvent.State({ state: answer.value, seq: null }))
            : Effect.void,
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
    const sequence = (event: DriverEvent): Option.Option<TransportEvent> => {
      if (event._tag !== 'StateReceived') return Option.some(event);
      const step = sequencer.receive(event.payload);
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
 * are published, and a `get_initial_state` answer is decoded and adopted by
 * the same sequencer so later deltas apply to it.
 */
export const makeSequencedTransport = (
  driver: SequencedAdapter,
  options: { readonly latestPerFrame: boolean },
): Effect.Effect<TmuxTransportService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sequencer } = driver;
    const feed = yield* Queue.unbounded<DriverEvent>();
    yield* forwardDriverEvents(driver, (event) => {
      feed.unsafeOffer(event);
    });
    const pubsub = yield* openEventPubSub;
    const base = serviceOver(driver, pubsub);

    // The last viewport the client reported, which a refetch asks for again.
    const viewport = { cols: 0, rows: 0 };
    const invoke = <T>(
      cmd: string,
      args?: Record<string, unknown>,
    ): Effect.Effect<T, AdapterError> => {
      if (
        (cmd === 'set_client_size' || cmd === 'get_initial_state') &&
        typeof args?.cols === 'number' &&
        typeof args?.rows === 'number'
      ) {
        viewport.cols = args.cols;
        viewport.rows = args.rows;
      }
      if (cmd !== 'get_initial_state') return base.invoke<T>(cmd, args);
      return base.invoke<unknown>(cmd, args).pipe(
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => sequencer.adopt(raw) as T,
            catch: (cause) => classifyAdapterError(cause, { command: cmd }),
          }),
        ),
      );
    };
    // A viewer never reports a viewport, and its refetch needs none.
    const resync = Effect.suspend(() =>
      !driver.readOnly && (viewport.cols === 0 || viewport.rows === 0)
        ? Effect.succeedNone
        : Effect.asSome(invoke<ServerState>('get_initial_state', { ...viewport })),
    );

    const sequenced = yield* sequenceStateUpdates(feed, sequencer, resync);
    yield* (options.latestPerFrame ? latestStatePerFrame(sequenced) : sequenced).pipe(
      Stream.runForEachChunk((chunk) => {
        Chunk.forEach(chunk, recordApplied);
        return PubSub.publishAll(pubsub, chunk);
      }),
      Effect.forkScoped,
    );
    return { ...base, invoke };
  });
