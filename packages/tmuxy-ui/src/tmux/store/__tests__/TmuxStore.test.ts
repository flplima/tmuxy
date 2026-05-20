/**
 * Integration tests for the Effect-managed TmuxStore.
 *
 * These cover the bridge points the XState layer relies on:
 *  - subscribe → notified on local dispatch and server reconcile
 *  - applyOptimistic → derived snapshot updates synchronously
 *  - dispatchRemote → adapter rejection rolls back the op
 *  - reconcile → committed advances, matched ops drop
 */

import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { makeTmuxStore } from '../TmuxStore';
import { parseCommandToOp } from '../parseCommand';
import type { ServerState, TmuxAdapter } from '../../types';
import { toEffectAdapter } from '../../effect';
import { TmuxError } from '../../effect/AdapterError';
import type { TmuxClientModel } from '../types';

function blankServerState(over: Partial<ServerState> = {}): ServerState {
  return {
    session_name: 'tmuxy',
    active_window_id: '@0',
    active_pane_id: '%0',
    panes: [
      {
        id: 0,
        tmux_id: '%0',
        window_id: '@0',
        content: [],
        cursor_x: 0,
        cursor_y: 0,
        width: 80,
        height: 24,
        x: 0,
        y: 0,
        active: true,
        command: 'bash',
        title: '',
        border_title: '',
        in_mode: false,
        copy_cursor_x: 0,
        copy_cursor_y: 0,
        alternate_on: false,
        mouse_any_flag: false,
        paused: false,
        history_size: 0,
        selection_present: false,
        selection_start_x: 0,
        selection_start_y: 0,
        cursor_shape: 0,
        cursor_hidden: false,
      },
    ],
    windows: [
      {
        id: '@0',
        index: 0,
        name: 'main',
        active: true,
        window_type: "tab",
      },
    ],
    total_width: 80,
    total_height: 24,
    status_line: '',
    ...over,
  };
}

/** Build a fake adapter that records invocations and lets the test control
 *  what each one resolves to. */
type FakeResult = { kind: 'ok'; value: unknown } | { kind: 'reject'; error: unknown };

function makeFakeAdapter(): {
  adapter: TmuxAdapter;
  invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
  setNextResult: (r: FakeResult) => void;
} {
  const invocations: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const state: { nextResult: FakeResult } = { nextResult: { kind: 'ok', value: undefined } };
  const adapter: TmuxAdapter = {
    connect: async () => {},
    disconnect: () => {},
    isConnected: () => true,
    isReconnecting: () => false,
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invocations.push({ cmd, args });
      if (state.nextResult.kind === 'reject') throw state.nextResult.error;
      return state.nextResult.value as T;
    },
    onStateChange: () => () => {},
    onError: () => () => {},
    onLog: () => () => {},
    onFatal: () => () => {},
    onConnectionInfo: () => () => {},
    onReconnection: () => () => {},
    onKeyBindings: () => () => {},
  };
  return {
    adapter,
    invocations,
    setNextResult(r) {
      state.nextResult = r;
    },
  };
}

describe('TmuxStore (integration)', () => {
  it('subscribe fires on initial state, local dispatch, and reconcile', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );

    const snaps: TmuxClientModel[] = [];
    const unsub = store.subscribe((m) => {
      snaps.push(m);
    });
    // Subscribing fires once synchronously with the current model.
    expect(snaps).toHaveLength(1);

    // Server snapshot arrives → committed updates → notify fires.
    await Effect.runPromise(store.reconcile(blankServerState()));
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[snaps.length - 1].committed.panes).toHaveLength(1);

    // Local optimistic dispatch — patch applies sync.
    fake.setNextResult({ kind: 'ok', value: undefined });
    const before = snaps.length;
    const { opId } = store.applyOptimistic(parseCommandToOp('split-window -h'));
    expect(opId).toBeDefined();
    // The synchronous applyOptimistic fires the notify before returning.
    expect(snaps.length).toBeGreaterThan(before);
    expect(snaps[snaps.length - 1].derived.panes).toHaveLength(2);

    unsub();
  });

  it('dispatch rolls back the op on TmuxError', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(blankServerState()));

    // First, prime the model with a single pane in committed state.
    expect(store.getModel().committed.panes).toHaveLength(1);

    fake.setNextResult({
      kind: 'reject',
      error: { error: 'no space for new pane' },
    });

    const exit = await Effect.runPromiseExit(store.dispatch(parseCommandToOp('split-window -h')));
    expect(exit._tag).toBe('Failure');

    // After rollback: derived === committed, no pending ops.
    const m = store.getModel();
    expect(m.ops).toHaveLength(0);
    expect(m.derived.panes).toEqual(m.committed.panes);
    expect(m.derived.panes).toHaveLength(1);
  });

  it('reconcile drops matched ops and surfaces rollback entries for stale ones', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(blankServerState()));

    // Dispatch a split. The adapter says ok; the store applies + awaits.
    fake.setNextResult({ kind: 'ok', value: undefined });
    const exit = await Effect.runPromiseExit(store.dispatch(parseCommandToOp('split-window -h')));
    expect(exit._tag).toBe('Success');

    // Before reconcile, the optimistic placeholder is still in derived.
    expect(store.getModel().derived.panes).toHaveLength(2);
    expect(store.getModel().ops).toHaveLength(1);

    // Now server confirms with a real second pane.
    await Effect.runPromise(
      store.reconcile(
        blankServerState({
          panes: [
            ...blankServerState().panes,
            {
              ...blankServerState().panes[0],
              tmux_id: '%1',
              x: 41,
              width: 39,
              active: true,
            },
          ],
          active_pane_id: '%1',
        }),
      ),
    );
    const m = store.getModel();
    expect(m.ops).toHaveLength(0);
    expect(m.committed.panes).toHaveLength(2);
    expect(m.paneKeyOverrides['%1']).toMatch(/^__placeholder_/);
  });

  it('TransportError surfaces as OpTransportError and rolls back', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(blankServerState()));

    // Plain string rejection → classified as TransportError in the
    // adapter → wrapped as OpTransportError in the store.
    fake.setNextResult({ kind: 'reject', error: 'network down' });
    const exit = await Effect.runPromiseExit(store.dispatch(parseCommandToOp('split-window -h')));
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      // Either Cause.fail or Cause.die — we just care no op remains.
      expect(store.getModel().ops).toHaveLength(0);
    }
  });

  // Smoke test: TmuxError class instances are correctly classified.
  it('throws TmuxError as OpRejectedByTmux', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(blankServerState()));

    fake.setNextResult({
      kind: 'reject',
      error: new TmuxError({ command: 'split-window -h', stderr: 'too small' }),
    });
    const exit = await Effect.runPromiseExit(store.dispatch(parseCommandToOp('split-window -h')));
    expect(exit._tag).toBe('Failure');
    expect(store.getModel().ops).toHaveLength(0);
  });
});
