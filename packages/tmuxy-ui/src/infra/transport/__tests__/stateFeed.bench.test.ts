/**
 * What the state feed costs per keystroke echo: a typical delta decoded and
 * sequenced (`StateSequencer.receive`, the work every transport did before
 * the stage existed), and the same delta carried the whole way through the
 * stage — driver hub, feed queue, sequencing, PubSub, subscriber — one at a
 * time (each awaited, as a typist produces them) and as a burst (a redraw).
 */

import { describe, expect, it } from 'vitest';
import { Effect, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { EventHub } from '../../eventHub';
import { makeSequencedTransport } from '../stateFeed';
import { TmuxTransport } from '../TmuxTransport';
import type { DriverEvent } from '../events';
import { StateSequencer } from '../stateSequencer';
import type { SequencedAdapter } from '../driver';
import { fullUpdate, ROWS, typicalDelta } from '../../../test/benchFixtures';

const N = 2000;
const deltas = Array.from({ length: N + 40 }, (_, i) => typicalDelta(i + 1));

const µs = (ms: number) => `${(ms * 1000).toFixed(1)}µs`;

/** Mean milliseconds per delta through the sequencer alone. */
function measureSequencer(): number {
  const sequencer = new StateSequencer();
  sequencer.receive(fullUpdate(ROWS));
  for (let i = 0; i < 40; i++) sequencer.receive(deltas[i]);
  const start = performance.now();
  for (let i = 40; i < N + 40; i++) {
    if (sequencer.receive(deltas[i])._tag !== 'State') throw new Error('delta did not apply');
  }
  return (performance.now() - start) / N;
}

/** A transport over a driver the benchmark pushes into, and a counting subscriber. */
async function openFeed() {
  const events = new EventHub<DriverEvent>();
  const driver: SequencedAdapter = {
    events,
    sequencer: new StateSequencer(),
    connect: async () => {},
    disconnect: () => {},
    invoke: async <T>() => null as T,
  };
  const runtime = ManagedRuntime.make(
    Layer.scoped(TmuxTransport, makeSequencedTransport(driver, { latestPerFrame: false })),
  );
  let seen = 0;
  let waiting: { count: number; resolve: () => void } | null = null;
  await runtime.runPromise(
    Effect.gen(function* () {
      const stream = yield* Scope.extend((yield* TmuxTransport).subscribe, yield* Scope.make());
      yield* Effect.forkDaemon(
        Stream.runForEachChunk(stream, (chunk) =>
          Effect.sync(() => {
            seen += chunk.length;
            if (waiting && seen >= waiting.count) waiting.resolve();
          }),
        ),
      );
    }),
  );
  const push = (payload: unknown) => events.emit({ _tag: 'StateReceived', payload });
  const until = (count: number) =>
    new Promise<void>((resolve) => {
      if (seen >= count) resolve();
      else waiting = { count, resolve };
    });
  return { runtime, push, until };
}

/** Mean milliseconds per delta through the stage: awaited one by one, and in one burst. */
async function measureStage(): Promise<{ single: number; burst: number }> {
  const feed = await openFeed();
  feed.push(fullUpdate(ROWS));
  await feed.until(1);
  for (let i = 0; i < 40; i++) feed.push(deltas[i]);
  await feed.until(41);

  const half = N / 2;
  let start = performance.now();
  for (let i = 40; i < 40 + half; i++) {
    feed.push(deltas[i]);
    await feed.until(i + 2);
  }
  const single = (performance.now() - start) / half;

  start = performance.now();
  for (let i = 40 + half; i < N + 40; i++) feed.push(deltas[i]);
  await feed.until(N + 41);
  const burst = (performance.now() - start) / half;

  await feed.runtime.dispose();
  return { single, burst };
}

describe('state feed cost', () => {
  it('decodes, sequences and publishes a typical delta well inside a frame', async () => {
    const sequencer = measureSequencer();
    const stage = await measureStage();
    console.info(
      `[state feed] sequencer: ${µs(sequencer)}/delta, ` +
        `through the stage: ${µs(stage.single)}/delta awaited, ${µs(stage.burst)}/delta in a burst`,
    );
    expect(sequencer).toBeLessThan(2);
    expect(stage.single).toBeLessThan(2);
    expect(stage.burst).toBeLessThan(2);
  });
});
