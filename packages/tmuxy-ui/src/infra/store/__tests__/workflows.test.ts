/**
 * Workflow tests for the TmuxClientModel + Store.
 *
 * Covers the integration shapes that the XState bridge depends on:
 *   - Prefix-pinned commands (keyboardActor's `select-pane -t %N \;` prefix)
 *     parse as the underlying op, not as a SelectPane.
 *   - The verbatim command string the keyboard sent is preserved on the wire,
 *     including tmux format strings (`-c "#{pane_current_path}"`).
 *   - Multiple concurrent in-flight ops compose on top of `committed` in
 *     dispatch order without colliding.
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
import { makeTmuxStore } from '../TmuxStore';
import { parseCommandToOp } from '../../../domain/store/parseCommand';
import { applyServerSnapshot, modelFromSnapshot, makePendingOp } from '../../../domain/store/model';
import type { OpId, TmuxSnapshot } from '../../../domain/store/types';
import type {
  ServerState,
  ServerStateEncoded,
  WirePaneEncoded,
  WireWindowEncoded,
} from '../../../domain/wire';
import { pid, wid, wireState } from '../../../test/wire';
import { dispatchRaw } from '../../../test/store';
import { fakeTransport, type FakeTransport } from '../../../test/transport';
import { TmuxError } from '../../transport/AdapterError';
import { predict } from '../../../domain/store/ops';

// ============================================
// Fixtures
// ============================================

const serverPane = (over: Partial<WirePaneEncoded> = {}): WirePaneEncoded => ({
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
  ...over,
});

const serverWindow = (over: Partial<WireWindowEncoded> = {}): WireWindowEncoded => ({
  id: wid('@0'),
  index: 0,
  name: 'main',
  active: true,
  window_type: 'tab',
  ...over,
});

const serverState = (over: Partial<ServerStateEncoded> = {}): ServerState =>
  wireState({
    session_name: 'tmuxy',
    active_window_id: wid('@0'),
    active_pane_id: pid('%0'),
    panes: [serverPane()],
    windows: [serverWindow()],
    total_width: 80,
    total_height: 24,
    ...over,
  });

/** What reached tmux, each as `cmd|args-json`. */
const sent = (fake: FakeTransport) =>
  fake.invocations.map((i) => `${i.cmd}|${JSON.stringify(i.args ?? {})}`);

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
    // A tiled pane's bindings carry a window pin in front of the pane pin.
    expect(
      parseCommandToOp('select-window -t @0 \\; select-pane -t %0 \\; split-window -h'),
    ).toEqual({
      _tag: 'Split',
      direction: 'vertical',
    });
    expect(parseCommandToOp('select-pane -t %2 \\; select-pane -L')).toEqual({
      _tag: 'Navigate',
      direction: 'L',
      script: false,
    });
    expect(parseCommandToOp('select-pane -t %5 \\; swap-pane -s %1 -t %2')).toEqual({
      _tag: 'Swap',
      sourcePaneId: pid('%1'),
      targetPaneId: pid('%2'),
      keepFocus: false,
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
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(serverState());

    const original = 'select-pane -t %0 \\; split-window -v -c "#{pane_current_path}"';
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromise(dispatchRaw(store, original));

    // The adapter should have seen the EXACT original string. If we'd
    // rebuilt from the op tag, this would be `split-window -h` and the
    // `-c "#{pane_current_path}"` (and the active-pane pin) would be lost.
    // The invocations array stringifies args via JSON, so the `\;` becomes
    // `\\;` — assert the meaningful tokens instead.
    expect(fake.invocations).toHaveLength(1);
    expect(sent(fake)[0]).toContain('split-window -v');
    expect(sent(fake)[0]).toContain('#{pane_current_path}');
    expect(sent(fake)[0]).toContain('select-pane -t %0');
  });
});

// ============================================
// 3. Multiple concurrent in-flight ops
// ============================================

describe('TmuxStore — multiple in-flight ops compose', () => {
  it('two splits in flight stack predictions on top of each other', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(serverState());

    fake.setNextResult({ kind: 'ok', value: undefined });

    // First split: 1 pane → 2 panes (placeholder added).
    const r1 = await fake.runtime.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(r1._tag).toBe('Success');
    expect(store.getModel().derived.panes).toHaveLength(2);
    expect(store.getModel().ops).toHaveLength(1);

    // Second split (before any server reconcile): predicted against the
    // CURRENT derived (which already has 2 panes including the placeholder).
    // The active pane in derived is the first placeholder, so the new
    // split's prediction is computed relative to it.
    const r2 = await fake.runtime.runPromiseExit(
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
          tmuxId: pid('%0'),
          windowId: wid('@0'),
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
          id: wid('@0'),
          index: 0,
          name: 'main',
          active: true,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
      totalWidth: 80,
      totalHeight: 24,
      focusRequest: '',
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
          tmuxId: pid('%1'),
          x: 40,
          width: 40,
          active: true,
        },
      ],
      activePaneId: pid('%1'),
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
// 4. Kill-pane reconcile
// ============================================

describe('TmuxStore — kill-pane reconcile', () => {
  it('drops paneKeyOverrides for removed panes', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();

    // Seed: 2 panes, plus a stale overlay entry for a pane that's about to die.
    store.reconcile(
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );

    // Inject a paneKeyOverride manually by running a split + reconcile.
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    store.reconcile(
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 20 }),
          serverPane({ tmux_id: pid('%2'), x: 61, width: 19, active: true }),
        ],
        active_pane_id: pid('%2'),
      }),
    );
    expect(Object.keys(store.getModel().paneKeyOverrides)).toContain(pid('%2'));

    // Server reports the new pane killed.
    store.reconcile(
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );

    // The stale override for %2 should be pruned.
    expect(store.getModel().paneKeyOverrides).not.toHaveProperty(pid('%2'));
    expect(store.getModel().derived.panes.map((p) => p.tmuxId)).toEqual([pid('%0'), pid('%1')]);
  });
});

// ============================================
// 5. Typed error surface
// ============================================

describe('TmuxStore — typed errors', () => {
  it('TmuxError surfaces as OpRejectedByTmux carrying stderr', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(serverState());

    fake.setNextResult({
      kind: 'reject',
      error: new TmuxError({
        command: 'split-window -h',
        stderr: "can't split pane: insufficient space",
      }),
    });
    const exit = await fake.runtime.runPromiseExit(
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
});

// ============================================
// 6. clear() drops everything (session switch)
// ============================================

describe('TmuxStore — clear (session switch)', () => {
  it('drops committed + pending ops and notifies subscribers', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();

    // Seed the store with a session, then dispatch an in-flight op.
    store.reconcile(serverState());
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    expect(store.getModel().committed.panes).toHaveLength(1);
    expect(store.getModel().ops).toHaveLength(1);

    // Switch session → clear.
    const snaps: number[] = [];
    const unsub = store.subscribe((m) => snaps.push(m.committed.panes.length));
    snaps.length = 0; // ignore the immediate "current" callback fired on subscribe
    store.clear();
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
// 7. canonical toTmuxCommand for ops constructed in code
// ============================================

describe('TmuxStore — toTmuxCommand fallback for in-code ops', () => {
  it('uses the canonical form when no command override is supplied', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(serverState());

    fake.setNextResult({ kind: 'ok', value: undefined });
    // SELECT_TAB constructs a SelectWindow op directly with no original
    // command string — the store should send `select-window -t N`.
    await fake.runtime.runPromise(store.dispatch({ _tag: 'SelectWindow', target: 3 }));
    expect(sent(fake)[0]).toContain('select-window -t 3');
  });
});

// ============================================
// 8. tmux output positions are honored (sanity)
// ============================================

describe('Op predictions — tmux-output shape', () => {
  // Tmux pane positions and sizes are integer cell counts (not pixels).
  // Splits divide the existing pane in half with a single-cell separator.
  // These tests pin our prediction to that contract so we'd catch any
  // drift in the math (e.g., off-by-one in separator handling).

  it('vertical split (-h) places the new pane to the right with a 1-cell separator', () => {
    const m = modelFromSnapshot({
      panes: [
        {
          id: 0,
          tmuxId: pid('%0'),
          windowId: wid('@0'),
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
          id: wid('@0'),
          index: 0,
          name: 'main',
          active: true,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
      totalWidth: 80,
      totalHeight: 24,
      focusRequest: '',
      sessionName: 'tmuxy',
    });
    const r = predict(
      { _tag: 'Split', direction: 'vertical' },
      m.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opV',
    )!;
    const next = r.patch(m.committed);
    const placeholder = next.panes.find((p) => p.tmuxId.startsWith('__placeholder_'))!;
    const original = next.panes.find((p) => p.tmuxId === pid('%0'))!;
    // 80 - floor(80/2) - 1 = 39 for the existing, 40 for the placeholder.
    expect(original.width).toBe(39);
    expect(placeholder.width).toBe(40);
    // Placeholder starts at original.width + 1 (separator cell).
    expect(placeholder.x).toBe(original.x + original.width + 1);
    // Heights are unchanged in a vertical split.
    expect(placeholder.height).toBe(original.height);
    expect(placeholder.y).toBe(original.y);
  });

  it('NewWindow prediction lands at max(index) + 1', () => {
    const m = modelFromSnapshot({
      panes: [],
      windows: [
        {
          id: wid('@5'),
          index: 5,
          name: 'a',
          active: true,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
        {
          id: wid('@7'),
          index: 7,
          name: 'b',
          active: false,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      activePaneId: null,
      activeWindowId: wid('@5'),
      totalWidth: 80,
      totalHeight: 24,
      focusRequest: '',
      sessionName: 'tmuxy',
    });
    const r = predict(
      { _tag: 'NewWindow' },
      m.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opNW',
    )!;
    const next = r.patch(m.committed);
    const newWin = next.windows.find((w) => w.id.startsWith('__placeholder_'))!;
    // Should land at 8 (max(5,7) + 1), matching tmux's "first available index after max".
    expect(newWin.index).toBe(8);
  });

  it('NewWindow prediction creates a full-viewport pane and focuses the new tab', () => {
    const m = modelFromSnapshot({
      panes: [],
      windows: [
        {
          id: wid('@5'),
          index: 5,
          name: 'a',
          active: true,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      activePaneId: null,
      activeWindowId: wid('@5'),
      totalWidth: 160,
      totalHeight: 48,
      focusRequest: '',
      sessionName: 'tmuxy',
    });
    const r = predict(
      { _tag: 'NewWindow' },
      m.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opNW2',
    )!;
    const next = r.patch(m.committed);
    const newWin = next.windows.find((w) => w.id.startsWith('__placeholder_'))!;
    const newPane = next.panes.find((p) => p.windowId === newWin.id)!;
    // Pane must match the full viewport, not inherit half-split dimensions.
    expect(newPane.x).toBe(0);
    expect(newPane.y).toBe(0);
    expect(newPane.width).toBe(160);
    expect(newPane.height).toBe(48);
    // The new tab is focused optimistically.
    expect(next.activeWindowId).toBe(newWin.id);
    expect(next.activePaneId).toBe(newPane.tmuxId);
    expect(newWin.active).toBe(true);
    // Prior tab is no longer the active one in the predicted snapshot.
    const priorWin = next.windows.find((w) => w.id === wid('@5'))!;
    expect(priorWin.active).toBe(false);
  });

  it('reconcile after sessionName change still cleanly matches new ops', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    // Session A
    store.reconcile(serverState({ session_name: 'A' }));
    // Clear (e.g. SWITCH_SESSION).
    store.clear();
    // Session B arrives — different ids reused.
    store.reconcile(
      serverState({
        session_name: 'B',
        panes: [serverPane({ tmux_id: pid('%0'), active: true })],
        active_pane_id: pid('%0'),
      }),
    );
    expect(store.getModel().committed.sessionName).toBe('B');
    expect(store.getModel().ops).toHaveLength(0);

    // A fresh dispatch in session B reconciles normally.
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    expect(store.getModel().ops).toHaveLength(1);
    store.reconcile(
      serverState({
        session_name: 'B',
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );
    expect(store.getModel().ops).toHaveLength(0);
    expect(store.getModel().committed.panes).toHaveLength(2);
  });
});
