import { describe, it, expect } from 'vitest';
import { makeTmuxStore } from '../TmuxStore';
import { applyServerSnapshot, makePendingOp } from '../../../domain/store/model';
import { modelFromSnapshot } from '../../../test/model';
import type { OpId, TmuxSnapshot } from '../../../domain/store/types';
import { pid, wid, wirePane, wireSession } from '../../../test/wire';
import { fakeTransport } from '../../../test/transport';
import { predict } from '../../../domain/store/ops';

describe('TmuxStore — multiple in-flight ops compose', () => {
  it('two splits in flight stack predictions on top of each other', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(wireSession());

    fake.setNextResult({ kind: 'ok', value: undefined });

    const r1 = await fake.runtime.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(r1._tag).toBe('Success');
    expect(store.getModel().derived.panes).toHaveLength(2);
    expect(store.getModel().ops).toHaveLength(1);

    const r2 = await fake.runtime.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(r2._tag).toBe('Success');
    expect(store.getModel().derived.panes).toHaveLength(3);
    expect(store.getModel().ops).toHaveLength(2);
  });

  it('reconcile clears matched op without disturbing the still-pending one', () => {
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
      pluginsRev: '',
      themeRev: '',
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
    expect(out.matched).toHaveLength(1);
    expect(out.model.ops).toHaveLength(1);
    expect(out.model.ops[0].id).toBe('op_b');
    expect(Object.values(out.model.paneKeyOverrides)).toHaveLength(1);
  });
});

describe('Op predictions — tmux-output shape', () => {
  // tmux pane positions and sizes are integer cell counts, and a split
  // divides the pane in half with a single-cell separator.

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
      pluginsRev: '',
      themeRev: '',
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
      pluginsRev: '',
      themeRev: '',
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
      pluginsRev: '',
      themeRev: '',
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
    expect(next.activeWindowId).toBe(newWin.id);
    expect(next.activePaneId).toBe(newPane.tmuxId);
    expect(newWin.active).toBe(true);
    const priorWin = next.windows.find((w) => w.id === wid('@5'))!;
    expect(priorWin.active).toBe(false);
  });

  it('reconcile after sessionName change still cleanly matches new ops', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(wireSession({ session_name: 'A' }));
    store.clear();
    // Session B reuses the ids session A had.
    store.reconcile(
      wireSession({
        session_name: 'B',
        panes: [wirePane({ tmux_id: pid('%0'), active: true })],
        active_pane_id: pid('%0'),
      }),
    );
    expect(store.getModel().committed.sessionName).toBe('B');
    expect(store.getModel().ops).toHaveLength(0);

    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    expect(store.getModel().ops).toHaveLength(1);
    store.reconcile(
      wireSession({
        session_name: 'B',
        panes: [
          wirePane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          wirePane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );
    expect(store.getModel().ops).toHaveLength(0);
    expect(store.getModel().committed.panes).toHaveLength(2);
  });
});
