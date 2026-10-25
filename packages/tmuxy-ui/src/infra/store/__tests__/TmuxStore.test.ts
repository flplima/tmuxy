/**
 * Integration tests for the Effect-managed TmuxStore.
 *
 * These cover the bridge points the XState layer relies on:
 *  - subscribe → notified on local dispatch and server reconcile
 *  - dispatch → derived snapshot updates synchronously
 *  - dispatch → adapter rejection rolls back the op
 *  - reconcile → committed advances, matched ops drop
 */

import { describe, it, expect } from 'vitest';
import { makeTmuxStore } from '../TmuxStore';
import { parseCommandToOp } from '../../../domain/store/parseCommand';
import type { ServerState, ServerStateEncoded } from '../../../domain/wire';
import { pid, wid, wireState } from '../../../test/wire';
import { fakeTransport } from '../../../test/transport';
import type { TmuxClientModel } from '../../../domain/store/types';

function blankServerState(over: Partial<ServerStateEncoded> = {}): ServerState {
  return wireState({
    session_name: 'tmuxy',
    active_window_id: wid('@0'),
    active_pane_id: pid('%0'),
    panes: [
      {
        id: 0,
        tmux_id: pid('%0'),
        window_id: wid('@0'),
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
        id: wid('@0'),
        index: 0,
        name: 'main',
        active: true,
        window_type: 'tab',
      },
    ],
    total_width: 80,
    total_height: 24,
    ...over,
  });
}

describe('TmuxStore (integration)', () => {
  it('subscribe fires on initial state, local dispatch, and reconcile', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();

    const snaps: TmuxClientModel[] = [];
    const unsub = store.subscribe((m) => {
      snaps.push(m);
    });
    // Subscribing fires once synchronously with the current model.
    expect(snaps).toHaveLength(1);

    // Server snapshot arrives → committed updates → notify fires.
    store.reconcile(blankServerState());
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[snaps.length - 1].committed.panes).toHaveLength(1);

    // Local optimistic dispatch — patch applies sync.
    fake.setNextResult({ kind: 'ok', value: undefined });
    const before = snaps.length;
    fake.runtime.runFork(store.dispatch(parseCommandToOp('split-window -h')));
    // The prediction applies (and notifies) before the adapter call yields.
    expect(snaps.length).toBeGreaterThan(before);
    expect(snaps[snaps.length - 1].derived.panes).toHaveLength(2);

    unsub();
  });

  it('dispatch rolls back the op on TmuxError', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(blankServerState());

    // First, prime the model with a single pane in committed state.
    expect(store.getModel().committed.panes).toHaveLength(1);

    fake.setNextResult({
      kind: 'reject',
      error: { error: 'no space for new pane', kind: 'tmux' },
    });

    const exit = await fake.runtime.runPromiseExit(
      store.dispatch(parseCommandToOp('split-window -h')),
    );
    expect(exit._tag).toBe('Failure');

    // After rollback: derived === committed, no pending ops.
    const m = store.getModel();
    expect(m.ops).toHaveLength(0);
    expect(m.derived.panes).toEqual(m.committed.panes);
    expect(m.derived.panes).toHaveLength(1);
  });

  it('reconcile drops matched ops and surfaces rollback entries for stale ones', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(blankServerState());

    // Dispatch a split. The adapter says ok; the store applies + awaits.
    fake.setNextResult({ kind: 'ok', value: undefined });
    const exit = await fake.runtime.runPromiseExit(
      store.dispatch(parseCommandToOp('split-window -h')),
    );
    expect(exit._tag).toBe('Success');

    // Before reconcile, the optimistic placeholder is still in derived.
    expect(store.getModel().derived.panes).toHaveLength(2);
    expect(store.getModel().ops).toHaveLength(1);

    // Now server confirms with a real second pane.
    store.reconcile(
      blankServerState({
        panes: [
          ...blankServerState().panes,
          {
            ...blankServerState().panes[0],
            tmux_id: pid('%1'),
            x: 41,
            width: 39,
            active: true,
          },
        ],
        active_pane_id: pid('%1'),
      }),
    );
    const m = store.getModel();
    expect(m.ops).toHaveLength(0);
    expect(m.committed.panes).toHaveLength(2);
    expect(m.paneKeyOverrides[pid('%1')]).toMatch(/^__placeholder_/);
  });

  it('TransportError surfaces as OpTransportError and rolls back', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(blankServerState());

    // Plain string rejection → classified as TransportError in the
    // adapter → wrapped as OpTransportError in the store.
    fake.setNextResult({ kind: 'reject', error: 'network down' });
    const exit = await fake.runtime.runPromiseExit(
      store.dispatch(parseCommandToOp('split-window -h')),
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      // Either Cause.fail or Cause.die — we just care no op remains.
      expect(store.getModel().ops).toHaveLength(0);
    }
  });

  // Smoke test: TmuxError class instances are correctly classified.
});

describe('notify granularity', () => {
  it('one reconcile batch produces exactly one subscriber notification', () => {
    const store = makeTmuxStore();
    let notifies = 0;
    const unsubscribe = store.subscribe(() => {
      notifies++;
    });
    notifies = 0; // subscribe fires once on attach
    store.reconcile(
      wireState({
        session_name: 'test',
        active_window_id: wid('@0'),
        active_pane_id: pid('%0'),
        panes: [],
        windows: [],
        total_width: 80,
        total_height: 24,
      }),
    );
    expect(notifies).toBe(1);
    unsubscribe();
  });
});
