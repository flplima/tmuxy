/**
 * Interleaving properties of the stream stage — C3, C4 and C5 in
 * `docs/INVARIANTS.md`.
 *
 * The scripted tests in `stateFeed.test.ts` each pin one ordering of deltas,
 * gaps and the initial-state answer. The bugs on this seam were all other
 * orderings: an answer landing after the stream had moved on, a gap during a
 * refetch, a refetch that failed and was never asked for again. So here the
 * server is a model — emission `i` sets the active pane to `%i`, a logical
 * clock, and each delta also adds a window and removes an older one, so the
 * state is the sum of every delta since the last full state and a delta
 * silently skipped leaves a trace the next one does not erase — and
 * fast-check picks which emissions are lost, when each answer resolves and
 * whether it fails. Whatever it picks, what the subscriber sees must never go
 * backwards, must always be exactly the server's state at its clock, must ask
 * for at most one refetch per loss (plus one per failed answer and one per
 * answer older than the stream it is adopted into), and must end on the
 * server's last emission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Effect, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { EventHub } from '../../eventHub';
import { makeSequencedTransport } from '../stateFeed';
import { TmuxTransport } from '../TmuxTransport';
import { type DriverEvent, type TransportEvent } from '../events';
import { StateSequencer } from '../stateSequencer';
import type { SequencedAdapter } from '../driver';

const win = (k: number) => ({
  id: `@${k}`,
  index: k,
  name: 'w',
  active: k === 1,
  window_type: 'tab',
});
/** The windows open after emission `i`: `@1` always, and the last three added. */
const windowsAt = (i: number) => {
  const ids = ['@1'];
  for (let k = Math.max(2, i - 2); k <= i; k += 1) ids.push(`@${k}`);
  return ids;
};
/** The server's state after emission `i`: the active pane is the clock. */
const serverState = (i: number) => ({
  session_name: 'tmuxy',
  active_window_id: '@1',
  active_pane_id: `%${i}`,
  panes: [],
  windows: windowsAt(i).map((id) => win(Number(id.slice(1)))),
  total_width: 80,
  total_height: 24,
  seq: i,
});
const fullAt = (i: number) => ({ type: 'full', state: serverState(i) });
/** Delta `i` opens window `@i` and closes `@(i-3)`: what it does is not undone by the next. */
const deltaAt = (i: number) => ({
  type: 'delta',
  delta: {
    seq: i,
    active_pane_id: `%${i}`,
    new_windows: [win(i)],
    ...(i - 3 >= 2 ? { windows: { [`@${i - 3}`]: null } } : {}),
  },
});
const clock = (state: { active_pane_id: string | null }) =>
  Number(String(state.active_pane_id).slice(1));
const windowIds = (state: { windows: ReadonlyArray<{ id: string }> }) =>
  state.windows.map((w) => w.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

/** What the server does at emission `i`: a delta, a full state, or a delta the wire loses. */
type Step = 'delta' | 'full' | 'drop';
const arbStep: fc.Arbitrary<Step> = fc.constantFrom('delta', 'delta', 'delta', 'full', 'drop');
/**
 * For the n-th refetch: how many emissions pass before its answer, how many
 * emissions old the answer is when it lands (a snapshot taken when the request
 * reached the server, while the stream kept going), and whether it fails.
 */
const arbAnswer = fc.record({ after: fc.nat(6), stale: fc.nat(6), ok: fc.boolean() });
const arbScript = fc.record({
  steps: fc.array(arbStep, { minLength: 1, maxLength: 25 }),
  answers: fc.array(arbAnswer, { maxLength: 12 }),
});

/**
 * A driver whose `get_initial_state` calls are queued for the test to answer
 * one by one, under a sequencer that counts what the stage has processed so
 * the test can wait for exactly that, however the fibers are scheduled.
 */
function modelDriver() {
  const events = new EventHub<DriverEvent>();
  const sequencer = new StateSequencer();
  const counts = { received: 0, marks: 0 };
  const receive = sequencer.receive.bind(sequencer);
  sequencer.receive = (raw) => {
    counts.received += 1;
    return receive(raw);
  };
  const current = sequencer.current.bind(sequencer);
  sequencer.current = () => {
    counts.marks += 1;
    return current();
  };
  const pending: Array<{ resolve: (raw: unknown) => void; reject: (e: Error) => void }> = [];
  const driver: SequencedAdapter = {
    events,
    sequencer,
    connect: async () => {},
    disconnect: () => {},
    invoke: <T>(cmd: string) => {
      if (cmd !== 'get_initial_state') return Promise.resolve(null as T);
      return new Promise<T>((resolve, reject) => {
        pending.push({ resolve: (raw) => resolve(raw as T), reject });
      });
    },
  };
  return { driver, counts, pending };
}

function openFeed() {
  const model = modelDriver();
  const layer = Layer.scoped(
    TmuxTransport,
    makeSequencedTransport(model.driver, { latestPerFrame: false }),
  );
  const runtime = ManagedRuntime.make(layer);
  const seen: TransportEvent[] = [];
  const ready = runtime.runPromise(
    Effect.gen(function* () {
      const events = yield* Scope.extend((yield* TmuxTransport).subscribe, yield* Scope.make());
      yield* Effect.forkDaemon(Stream.runForEach(events, (e) => Effect.sync(() => seen.push(e))));
      yield* Effect.flatMap(TmuxTransport, (t) =>
        t.invoke('set_client_size', { cols: 80, rows: 24 }),
      );
    }),
  );
  let pushed = 0;
  let answeredOk = 0;
  const push = (payload: unknown) => {
    pushed += 1;
    model.driver.events.emit({ _tag: 'StateReceived', payload });
  };
  /** Every pushed payload has been sequenced and every adopted answer published. */
  const settled = async () => {
    await vi.waitFor(() => {
      expect(model.counts.received).toBe(pushed);
      expect(model.counts.marks).toBe(answeredOk);
    });
    // A gap forks the refetch; let that fiber reach the driver.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const answer = (n: number, raw: unknown) => {
    answeredOk += 1;
    model.pending[n].resolve(raw);
  };
  const fail = (n: number) => model.pending[n].reject(new Error('refetch failed'));
  const paints = () =>
    seen.flatMap((e) =>
      e._tag === 'State' ? [{ clock: clock(e.state), windows: windowIds(e.state) }] : [],
    );
  return {
    ready,
    push,
    settled,
    answer,
    fail,
    paints,
    fetches: () => model.pending.length,
    dispose: () => runtime.dispose(),
  };
}

describe('the state feed stage, under any interleaving of the stream and the answer', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it('never paints backwards, never paints a guess, refetches at most once per loss, and ends on the server', async () => {
    await fc.assert(
      fc.asyncProperty(arbScript, async ({ steps, answers }) => {
        const feed = openFeed();
        try {
          await feed.ready;
          feed.push(fullAt(0));
          await feed.settled();

          const dropped = new Set<number>();
          // The clocks the client was handed: pushed emissions and answers.
          // An answer is the server's state when it resolves, so it can carry
          // the effect of a lost delta; a painted clock from nowhere else is a
          // guess.
          const delivered = new Set<number>([0]);
          const scheduled: Array<{
            from: number;
            at: number;
            stale: number;
            ok: boolean;
            done: boolean;
          }> = [];
          let failures = 0;
          let staleAnswers = 0;
          let i = 0;
          /**
           * Answer every refetch whose time has come, with the server's state
           * as of some emission between the request and now.
           */
          const answerDue = async () => {
            while (scheduled.length < feed.fetches()) {
              const a = answers[scheduled.length] ?? { after: 0, stale: 0, ok: true };
              scheduled.push({ from: i, at: i + a.after, stale: a.stale, ok: a.ok, done: false });
            }
            for (const [n, s] of scheduled.entries()) {
              if (s.done || s.at > i) continue;
              s.done = true;
              if (s.ok) {
                const asOf = Math.max(s.from, i - s.stale);
                delivered.add(asOf);
                // An answer older than the stream, adopted after a gap, is a
                // sync point the next delta does not follow: one more refetch
                // is the right answer, not a delta applied over the hole.
                if (asOf < i) staleAnswers += 1;
                feed.answer(n, serverState(asOf));
              } else {
                failures += 1;
                feed.fail(n);
              }
              await feed.settled();
            }
          };

          for (const step of steps) {
            i += 1;
            if (step === 'drop') dropped.add(i);
            else {
              delivered.add(i);
              feed.push(step === 'delta' ? deltaAt(i) : fullAt(i));
            }
            await feed.settled();
            await answerDue();
          }
          // Let the stream recover: answer what is still out, then one more
          // delta. A scripted answer that fails makes that delta ask again;
          // the refetch it starts is answered well, so this ends.
          for (;;) {
            while (scheduled.length < feed.fetches()) {
              scheduled.push({ from: i, at: i, stale: 0, ok: true, done: false });
            }
            for (const s of scheduled) s.at = i;
            await answerDue();
            i += 1;
            delivered.add(i);
            feed.push(deltaAt(i));
            await feed.settled();
            if (feed.fetches() === scheduled.length) break;
          }

          const paints = feed.paints();
          const painted = paints.map((p) => p.clock);
          for (let n = 1; n < painted.length; n += 1) {
            expect(painted[n], `painted ${painted.join(',')} after ${steps.join(',')}`).toBe(
              Math.max(painted[n], painted[n - 1]),
            );
          }
          for (const { clock: k, windows } of paints) {
            expect(delivered.has(k), `clock ${k} was painted but never delivered`).toBe(true);
            // The whole state, not just the clock: a delta skipped on the
            // way to this paint leaves a window open or missing here.
            expect(windows, `the paint at clock ${k} is not the server's state`).toEqual(
              windowsAt(k),
            );
          }
          expect(feed.fetches()).toBeLessThanOrEqual(dropped.size + failures + staleAnswers);
          expect(painted[painted.length - 1]).toBe(i);
        } finally {
          await feed.dispose();
        }
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
