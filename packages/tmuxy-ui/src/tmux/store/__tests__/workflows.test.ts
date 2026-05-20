/**
 * Workflow tests for the Tier-3 TmuxClientModel + Store.
 *
 * Covers the integration shapes that the XState bridge depends on:
 *   - Prefix-pinned commands (keyboardActor's `select-pane -t %N \;` prefix)
 *     parse as the underlying op, not as a SelectPane.
 *   - The verbatim command string the keyboard sent is preserved on the wire,
 *     including tmux format strings (`-c "#{pane_current_path}"`).
 *   - Multiple concurrent in-flight ops compose on top of `committed` in
 *     dispatch order without colliding.
 *   - Drag-time swaps with skipPrediction don't double-shuffle pane positions.
 *   - Reconcile correctly handles real-world deltas (kill-pane, layout
 *     reshuffle, window close).
 *   - TmuxError → automatic rollback; OpRejectedByTmux ADT surfaces the
 *     stderr to the caller.
 *
 * These are the shapes E2E tests can't drive directly — they're the
 * semantic contracts at the store boundary, not "does clicking split add a
 * pane in the DOM."
 */

import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { makeTmuxStore } from '../TmuxStore';
import { parseCommandToOp } from '../parseCommand';
import { applyServerSnapshot, modelFromSnapshot, makePendingOp } from '../model';
import type { OpId, TmuxOp, TmuxSnapshot } from '../types';
import type { ServerState, ServerPane, ServerWindow, TmuxAdapter } from '../../types';
import { toEffectAdapter } from '../../effect';
import { TmuxError } from '../../effect/AdapterError';
import { predict } from '../ops';

// ============================================
// Fixtures
// ============================================

const serverPane = (over: Partial<ServerPane> = {}): ServerPane => ({
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
  ...over,
});

const serverWindow = (over: Partial<ServerWindow> = {}): ServerWindow => ({
  id: '@0',
  index: 0,
  name: 'main',
  active: true,
  is_pane_group_window: false,
  pane_group_pane_ids: null,
  is_float_window: false,
  float_pane_id: null,
  ...over,
});

const serverState = (over: Partial<ServerState> = {}): ServerState => ({
  session_name: 'tmuxy',
  active_window_id: '@0',
  active_pane_id: '%0',
  panes: [serverPane()],
  windows: [serverWindow()],
  total_width: 80,
  total_height: 24,
  status_line: '',
  ...over,
});

interface FakeAdapter {
  adapter: TmuxAdapter;
  invocations: string[];
  setNextResult: (r: { kind: 'ok'; value: unknown } | { kind: 'reject'; error: unknown }) => void;
}

function makeFakeAdapter(): FakeAdapter {
  const invocations: string[] = [];
  const state = {
    nextResult: { kind: 'ok' as const, value: undefined as unknown } as
      | { kind: 'ok'; value: unknown }
      | { kind: 'reject'; error: unknown },
  };
  const adapter: TmuxAdapter = {
    connect: async () => {},
    disconnect: () => {},
    isConnected: () => true,
    isReconnecting: () => false,
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invocations.push(`${cmd}|${JSON.stringify(args ?? {})}`);
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
    setNextResult: (r) => {
      state.nextResult = r;
    },
  };
}

// ============================================
// 1. Prefix-pinned commands
// ============================================

describe('parseCommandToOp — prefix-pinned commands', () => {
  // The keyboardActor prefixes EVERY prefix/root-bound command with
  // `select-pane -t %N \;` so tmux's server-side active pane lines up with
  // ours before the binding runs. The parser must look past that prefix to
  // classify the real op — otherwise every prefix binding parsed as a
  // no-op SelectPane and the actual side effect was lost.

  it('classifies the binding tail, not the select-pane prefix', () => {
    expect(parseCommandToOp('select-pane -t %0 \\; split-window -v')).toEqual({
      _tag: 'Split',
      direction: 'horizontal',
    });
    expect(parseCommandToOp('select-pane -t %3 \\; split-window -h')).toEqual({
      _tag: 'Split',
      direction: 'vertical',
    });
    expect(parseCommandToOp('select-pane -t %1 \\; new-window')).toEqual({
      _tag: 'NewWindow',
    });
    expect(parseCommandToOp('select-pane -t %2 \\; select-pane -L')).toEqual({
      _tag: 'Navigate',
      direction: 'L',
    });
    expect(parseCommandToOp('select-pane -t %5 \\; swap-pane -s %1 -t %2')).toEqual({
      _tag: 'Swap',
      sourcePaneId: '%1',
      targetPaneId: '%2',
    });
  });

  it('preserves tmux format strings in RawCommand fallback', () => {
    // Bindings often carry `-c "#{pane_current_path}"` so the new pane
    // inherits cwd. The parser shouldn't try to predict this — it should
    // pass through as Split with the original command preserved
    // separately (verified in the store tests below).
    const cmd = 'select-pane -t %0 \\; split-window -v -c "#{pane_current_path}"';
    expect(parseCommandToOp(cmd)).toEqual({ _tag: 'Split', direction: 'horizontal' });
  });
});

// ============================================
// 2. Verbatim command preservation
// ============================================

describe('TmuxStore — verbatim command preservation', () => {
  it('sends the caller-provided command string, not the op canonical form', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(serverState()));

    const original = 'select-pane -t %0 \\; split-window -v -c "#{pane_current_path}"';
    fake.setNextResult({ kind: 'ok', value: undefined });
    await Effect.runPromise(store.dispatchCommand(original));

    // The adapter should have seen the EXACT original string. If we'd
    // rebuilt from the op tag, this would be `split-window -h` and the
    // `-c "#{pane_current_path}"` (and the active-pane pin) would be lost.
    // The invocations array stringifies args via JSON, so the `\;` becomes
    // `\\;` — assert the meaningful tokens instead.
    expect(fake.invocations).toHaveLength(1);
    expect(fake.invocations[0]).toContain('split-window -v');
    expect(fake.invocations[0]).toContain('#{pane_current_path}');
    expect(fake.invocations[0]).toContain('select-pane -t %0');
  });

  it('explicit applyOptimistic.command override wins over toTmuxCommand', () => {
    const m = modelFromSnapshot({
      panes: [
        {
          id: 0,
          tmuxId: '%0',
          windowId: '@0',
          content: [],
          cursorX: 0,
          cursorY: 0,
          width: 80,
          height: 24,
          x: 0,
          y: 0,
          active: true,
          command: 'bash',
          title: '',
          borderTitle: '',
          inMode: false,
          copyCursorX: 0,
          copyCursorY: 0,
          alternateOn: false,
          mouseAnyFlag: false,
          paused: false,
          historySize: 0,
          selectionPresent: false,
          selectionStartX: 0,
          selectionStartY: 0,
          cursorShape: 0,
          cursorHidden: false,
        },
      ],
      windows: [
        {
          id: '@0',
          index: 0,
          name: 'main',
          active: true,
          isPaneGroupWindow: false,
          paneGroupPaneIds: null,
          isFloatWindow: false,
          floatPaneId: null,
        },
      ],
      activePaneId: '%0',
      activeWindowId: '@0',
      totalWidth: 80,
      totalHeight: 24,
      statusLine: '',
      sessionName: 'tmuxy',
    });
    const op: TmuxOp = { _tag: 'Split', direction: 'vertical' };
    const result = predict(op, m.committed, { defaultShell: 'bash', paneActivationOrder: [] }, 'X');
    expect(result).not.toBeNull();
    // The op's canonical command is `split-window -h` — but the test
    // simulates the keyboardActor sending the full string including
    // the prefix-pin AND the -c flag. The pending op carries the
    // original; that's what hits the wire.
    const pending = makePendingOp({
      id: 'op_full' as OpId,
      op,
      command: 'select-pane -t %0 \\; split-window -h -c "#{pane_current_path}"',
      patch: result!.patch,
      meta: result!.meta,
    });
    expect(pending.command).toContain('#{pane_current_path}');
  });
});

// ============================================
// 3. Multiple concurrent in-flight ops
// ============================================

describe('TmuxStore — multiple in-flight ops compose', () => {
  it('two splits in flight stack predictions on top of each other', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(serverState()));

    fake.setNextResult({ kind: 'ok', value: undefined });

    // First split: 1 pane → 2 panes (placeholder added).
    const r1 = await Effect.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(r1._tag).toBe('Success');
    expect(store.getModel().derived.panes).toHaveLength(2);
    expect(store.getModel().ops).toHaveLength(1);

    // Second split (before any server reconcile): predicted against the
    // CURRENT derived (which already has 2 panes including the placeholder).
    // The active pane in derived is the first placeholder, so the new
    // split's prediction is computed relative to it.
    const r2 = await Effect.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(r2._tag).toBe('Success');
    // Two predicted patches stacked → 3 panes in derived.
    expect(store.getModel().derived.panes).toHaveLength(3);
    expect(store.getModel().ops).toHaveLength(2);
  });

  it('reconcile clears matched op without disturbing the still-pending one', () => {
    // Start from committed=1 pane, then build two pending splits manually
    // (simpler than dispatch chain, same shape).
    const baseSnap: TmuxSnapshot = {
      panes: [
        {
          id: 0,
          tmuxId: '%0',
          windowId: '@0',
          content: [],
          cursorX: 0,
          cursorY: 0,
          width: 80,
          height: 24,
          x: 0,
          y: 0,
          active: true,
          command: 'bash',
          title: '',
          borderTitle: '',
          inMode: false,
          copyCursorX: 0,
          copyCursorY: 0,
          alternateOn: false,
          mouseAnyFlag: false,
          paused: false,
          historySize: 0,
          selectionPresent: false,
          selectionStartX: 0,
          selectionStartY: 0,
          cursorShape: 0,
          cursorHidden: false,
        },
      ],
      windows: [
        {
          id: '@0',
          index: 0,
          name: 'main',
          active: true,
          isPaneGroupWindow: false,
          paneGroupPaneIds: null,
          isFloatWindow: false,
          floatPaneId: null,
        },
      ],
      activePaneId: '%0',
      activeWindowId: '@0',
      totalWidth: 80,
      totalHeight: 24,
      statusLine: '',
      sessionName: 'tmuxy',
    };
    const m0 = modelFromSnapshot(baseSnap);
    const r1 = predict(
      { _tag: 'Split', direction: 'vertical' },
      m0.derived,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'A',
    )!;
    const split1 = makePendingOp({
      id: 'op_a' as OpId,
      op: { _tag: 'Split', direction: 'vertical' },
      command: 'split-window -h',
      patch: r1.patch,
      meta: r1.meta,
    });
    const m1 = { ...m0, ops: [split1] };
    const m1Derived = m1.ops.reduce((s, o) => o.patch(s), m1.committed);
    const r2 = predict(
      { _tag: 'Split', direction: 'vertical' },
      m1Derived,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'B',
    )!;
    const split2 = makePendingOp({
      id: 'op_b' as OpId,
      op: { _tag: 'Split', direction: 'vertical' },
      command: 'split-window -h',
      patch: r2.patch,
      meta: r2.meta,
    });
    const m2 = {
      ...m1,
      ops: [split1, split2],
      derived: m1.ops.concat(split2).reduce((s, o) => o.patch(s), m1.committed),
    };

    // Server confirms the first split (real pane %1 appeared) but the
    // second one is still pending.
    const serverSnap: TmuxSnapshot = {
      ...baseSnap,
      panes: [
        {
          ...baseSnap.panes[0],
          width: 39,
        },
        {
          ...baseSnap.panes[0],
          id: 1,
          tmuxId: '%1',
          x: 40,
          width: 40,
          active: true,
        },
      ],
      activePaneId: '%1',
    };

    const out = applyServerSnapshot(m2, serverSnap, Date.now());
    // First op matched and dropped, second op still pending.
    expect(out.matched).toHaveLength(1);
    expect(out.model.ops).toHaveLength(1);
    expect(out.model.ops[0].id).toBe('op_b');
    // paneKeyOverrides records the real-id → placeholder mapping for the
    // matched op only.
    expect(Object.values(out.model.paneKeyOverrides)).toHaveLength(1);
  });
});

// ============================================
// 4. skipPrediction for drag-time swaps
// ============================================

describe('TmuxStore — skipPrediction', () => {
  it('applies an identity patch when skipPrediction is set', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(
      store.reconcile(
        serverState({
          panes: [
            serverPane({ tmux_id: '%0', x: 0, width: 39 }),
            serverPane({ tmux_id: '%1', x: 40, width: 40, active: true }),
          ],
          active_pane_id: '%1',
        }),
      ),
    );
    const before = store.getModel().derived.panes.map((p) => `${p.tmuxId}@${p.x}`);

    fake.setNextResult({ kind: 'ok', value: undefined });
    const exit = await Effect.runPromiseExit(
      store.dispatchCommand('swap-pane -s %0 -t %1', { skipPrediction: true }),
    );
    expect(exit._tag).toBe('Success');

    // No predicted swap applied — derived positions are unchanged.
    const after = store.getModel().derived.panes.map((p) => `${p.tmuxId}@${p.x}`);
    expect(after).toEqual(before);
  });
});

// ============================================
// 5. Kill-pane reconcile
// ============================================

describe('TmuxStore — kill-pane reconcile', () => {
  it('drops paneKeyOverrides for removed panes', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );

    // Seed: 2 panes, plus a stale overlay entry for a pane that's about to die.
    await Effect.runPromise(
      store.reconcile(
        serverState({
          panes: [
            serverPane({ tmux_id: '%0', x: 0, width: 39 }),
            serverPane({ tmux_id: '%1', x: 40, width: 40, active: true }),
          ],
          active_pane_id: '%1',
        }),
      ),
    );

    // Inject a paneKeyOverride manually by running a split + reconcile.
    fake.setNextResult({ kind: 'ok', value: undefined });
    await Effect.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    await Effect.runPromise(
      store.reconcile(
        serverState({
          panes: [
            serverPane({ tmux_id: '%0', x: 0, width: 39 }),
            serverPane({ tmux_id: '%1', x: 40, width: 20 }),
            serverPane({ tmux_id: '%2', x: 61, width: 19, active: true }),
          ],
          active_pane_id: '%2',
        }),
      ),
    );
    expect(Object.keys(store.getModel().paneKeyOverrides)).toContain('%2');

    // Server reports the new pane killed.
    await Effect.runPromise(
      store.reconcile(
        serverState({
          panes: [
            serverPane({ tmux_id: '%0', x: 0, width: 39 }),
            serverPane({ tmux_id: '%1', x: 40, width: 40, active: true }),
          ],
          active_pane_id: '%1',
        }),
      ),
    );

    // The stale override for %2 should be pruned.
    expect(store.getModel().paneKeyOverrides).not.toHaveProperty('%2');
    expect(store.getModel().derived.panes.map((p) => p.tmuxId)).toEqual(['%0', '%1']);
  });
});

// ============================================
// 6. Typed error surface
// ============================================

describe('TmuxStore — typed errors', () => {
  it('TmuxError surfaces as OpRejectedByTmux carrying stderr', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(serverState()));

    fake.setNextResult({
      kind: 'reject',
      error: new TmuxError({
        command: 'split-window -h',
        stderr: "can't split pane: insufficient space",
      }),
    });
    const exit = await Effect.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      // Extract the tagged error from the cause.
      const cause = exit.cause;
      const causeStr = JSON.stringify(cause);
      expect(causeStr).toContain('OpRejectedByTmux');
      expect(causeStr).toContain('insufficient space');
    }
    // No pending op survives a rejection.
    expect(store.getModel().ops).toHaveLength(0);
  });

  it('rejecting object-shape {error: ...} (Rust convention) also rolls back', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(serverState()));

    fake.setNextResult({ kind: 'reject', error: { error: 'no such pane: %999' } });
    const exit = await Effect.runPromiseExit(
      store.dispatch({ _tag: 'Swap', sourcePaneId: '%999', targetPaneId: '%0' }),
    );
    expect(exit._tag).toBe('Failure');
    expect(store.getModel().ops).toHaveLength(0);
  });
});

// ============================================
// 7. clear() drops everything (session switch)
// ============================================

describe('TmuxStore — clear (session switch)', () => {
  it('drops committed + pending ops and notifies subscribers', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );

    // Seed the store with a session, then dispatch an in-flight op.
    await Effect.runPromise(store.reconcile(serverState()));
    fake.setNextResult({ kind: 'ok', value: undefined });
    await Effect.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    expect(store.getModel().committed.panes).toHaveLength(1);
    expect(store.getModel().ops).toHaveLength(1);

    // Switch session → clear.
    const snaps: number[] = [];
    const unsub = store.subscribe((m) => snaps.push(m.committed.panes.length));
    snaps.length = 0; // ignore the immediate "current" callback fired on subscribe
    await Effect.runPromise(store.clear());
    unsub();
    // The clear should have fired exactly one notification with empty panes.
    expect(snaps).toEqual([0]);

    const m = store.getModel();
    expect(m.committed.panes).toHaveLength(0);
    expect(m.committed.windows).toHaveLength(0);
    expect(m.ops).toHaveLength(0);
    expect(m.derived.panes).toHaveLength(0);
    expect(Object.keys(m.paneKeyOverrides)).toHaveLength(0);
  });
});

// ============================================
// 8. canonical toTmuxCommand for ops constructed in code
// ============================================

describe('TmuxStore — toTmuxCommand fallback for in-code ops', () => {
  it('uses the canonical form when no command override is supplied', async () => {
    const fake = makeFakeAdapter();
    const store = await Effect.runPromise(
      makeTmuxStore({ adapter: toEffectAdapter(fake.adapter) }),
    );
    await Effect.runPromise(store.reconcile(serverState()));

    fake.setNextResult({ kind: 'ok', value: undefined });
    // SELECT_TAB constructs a SelectWindow op directly with no original
    // command string — the store should send `select-window -t N`.
    await Effect.runPromise(store.dispatch({ _tag: 'SelectWindow', target: 3 }));
    expect(fake.invocations[0]).toContain('select-window -t 3');
  });
});
