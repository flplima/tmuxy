/**
 * The stream stage, behind a test Layer: a scripted driver that pushes raw
 * `state-update` payloads and answers `get_initial_state` when the test says,
 * under the real `makeSequencedTransport`. What a subscriber sees is what the
 * app sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { EventHub } from '../../eventHub';
import { makeSequencedTransport } from '../stateFeed';
import { TmuxTransport, type TmuxTransportService } from '../TmuxTransport';
import { type DriverEvent, TransportEvent } from '../events';
import { StateSequencer } from '../../../tmux/stateStream';
import type { SequencedAdapter } from '../../../tmux/types';

const state = (activePane = '%1', windows = ['@1']) => ({
  session_name: 'tmuxy',
  active_window_id: '@1',
  active_pane_id: activePane,
  panes: [],
  windows: windows.map((id, i) => ({
    id,
    index: i + 1,
    name: 'main',
    active: i === 0,
    window_type: 'tab',
  })),
  total_width: 80,
  total_height: 24,
});
const full = (activePane?: string) => ({ type: 'full', state: state(activePane) });
const delta = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: 'delta',
  delta: { seq, ...extra },
});

/** A driver the test scripts: `push` a raw payload, `answer` the pending initial-state fetch. */
function scriptedDriver() {
  const events = new EventHub<DriverEvent>();
  const fetches: Array<Record<string, unknown> | undefined> = [];
  let answer: (raw: unknown) => void = () => {};
  const driver: SequencedAdapter = {
    events,
    sequencer: new StateSequencer(),
    connect: async () => {},
    disconnect: () => {},
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'get_initial_state') return Promise.resolve(null as T);
      fetches.push(args);
      return new Promise<T>((resolve) => {
        answer = (raw) => resolve(raw as T);
      });
    },
  };
  return {
    driver,
    fetches,
    push: (payload: unknown) => events.emit({ _tag: 'StateReceived', payload }),
    emit: (event: TransportEvent) => events.emit(event),
    answer: (raw: unknown) => answer(raw),
  };
}

/** The test Layer over a scripted driver, and what its subscriber has seen. */
function openFeed() {
  const script = scriptedDriver();
  const layer = Layer.scoped(
    TmuxTransport,
    makeSequencedTransport(script.driver, { latestPerFrame: false }),
  );
  const runtime = ManagedRuntime.make(layer);
  const seen: TransportEvent[] = [];
  // Subscribed before the test pushes anything, consumed for the runtime's life.
  const subscribed = runtime.runPromise(
    Effect.gen(function* () {
      const events = yield* Scope.extend((yield* TmuxTransport).subscribe, yield* Scope.make());
      yield* Effect.forkDaemon(Stream.runForEach(events, (e) => Effect.sync(() => seen.push(e))));
    }),
  );
  const call = <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(TmuxTransport, f));
  const states = () =>
    seen.flatMap((e) => (e._tag === 'State' ? [{ seq: e.seq, state: e.state }] : []));
  const last = () => states()[states().length - 1]?.state;
  return { ...script, runtime, seen, states, last, call, ready: subscribed };
}

describe('the state feed stage', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it('publishes a full state then deltas in sequence, other events in their place', async () => {
    const feed = openFeed();
    await feed.ready;
    feed.push(full());
    feed.emit(TransportEvent.Log({ kind: 'info', message: 'between' }));
    feed.push(delta(1, { active_pane_id: '%2' }));
    feed.push(delta(2, { active_pane_id: '%3' }));

    await vi.waitFor(() => expect(feed.seen).toHaveLength(4));
    expect(feed.seen.map((e) => e._tag)).toEqual(['State', 'Log', 'State', 'State']);
    expect(feed.states().map((s) => [s.seq, s.state.active_pane_id])).toEqual([
      [null, '%1'],
      [1, '%2'],
      [2, '%3'],
    ]);
    await feed.runtime.dispose();
  });

  it('a gap refetches one full state at the last viewport and publishes it', async () => {
    const feed = openFeed();
    await feed.ready;
    // The viewport the client reported, which the refetch asks for again.
    void feed.call((t) => t.invoke('set_client_size', { cols: 120, rows: 40 }));
    feed.push(full());
    feed.push(delta(1));
    feed.push(delta(3));
    // The stream carries on from the next delta; a second gap while the first
    // refetch is out asks for nothing more.
    feed.push(delta(4));
    feed.push(delta(6));
    await vi.waitFor(() => expect(feed.fetches).toHaveLength(1));
    expect(feed.fetches[0]).toEqual({ cols: 120, rows: 40 });

    feed.answer(state('%1', ['@1', '@5']));
    await vi.waitFor(() => expect(feed.last()?.windows.map((w) => w.id)).toEqual(['@1', '@5']));
    expect(feed.states().map((s) => s.seq)).toEqual([null, 1, 4, null]);
    expect(feed.fetches).toHaveLength(1);
    await feed.runtime.dispose();
  });

  it('a payload that does not decode is a gap: logged, never published, refetched', async () => {
    const feed = openFeed();
    await feed.ready;
    void feed.call((t) => t.invoke('set_client_size', { cols: 80, rows: 24 }));
    feed.push(full());
    feed.push(delta(1, { active_pane_id: 'not-a-pane' }));
    await vi.waitFor(() => expect(feed.fetches).toHaveLength(1));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('state-update'), expect.anything());

    feed.answer(state('%4'));
    await vi.waitFor(() => expect(feed.last()?.active_pane_id).toBe('%4'));
    expect(feed.states().some((s) => s.state.active_pane_id === 'not-a-pane')).toBe(false);
    await feed.runtime.dispose();
  });

  it('with no viewport reported yet, a gap waits for the next full state', async () => {
    const feed = openFeed();
    await feed.ready;
    feed.push(full());
    feed.push(delta(2));
    feed.push(full('%9'));
    await vi.waitFor(() => expect(feed.last()?.active_pane_id).toBe('%9'));
    expect(feed.fetches).toHaveLength(0);
    await feed.runtime.dispose();
  });
});
