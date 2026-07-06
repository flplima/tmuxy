import { describe, it, expect } from 'vitest';
import {
  modelFromSnapshot,
  addPendingOp,
  applyServerSnapshot,
  makePendingOp,
  recomputeDerived,
  rollbackOp,
} from '../model';
import { predict } from '../ops';
import { parseCommandToOp, toTmuxCommand } from '../parseCommand';
import type { TmuxOp, TmuxSnapshot, OpId } from '../types';
import { OP_STALE_TIMEOUT_MS, OP_ACKED_STALE_TIMEOUT_MS } from '../types';
import type { TmuxPane, TmuxWindow } from '../../types';

const pane = (over: Partial<TmuxPane> = {}): TmuxPane => ({
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
  active: false,
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
  ...over,
});

const win = (over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  id: '@0',
  index: 0,
  name: 'main',
  active: true,
  windowType: 'tab',
  groupPanes: null,
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
  ...over,
});

const snapshot = (over: Partial<TmuxSnapshot> = {}): TmuxSnapshot => ({
  panes: [pane({ active: true })],
  windows: [win()],
  activePaneId: '%0',
  activeWindowId: '@0',
  totalWidth: 80,
  totalHeight: 24,
  statusLine: '',
  sessionName: 'tmuxy',
  ...over,
});

describe('TmuxClientModel', () => {
  it('derived equals committed when no ops are in flight', () => {
    const m = modelFromSnapshot(snapshot());
    expect(m.derived).toEqual(m.committed);
  });

  it('split prediction adds a placeholder pane to derived', () => {
    const m = modelFromSnapshot(snapshot());
    const op: TmuxOp = { _tag: 'Split', direction: 'vertical' };
    const result = predict(
      op,
      m.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opX',
    );
    expect(result).not.toBeNull();
    const pending = makePendingOp({
      id: 'op_x' as OpId,
      op,
      command: toTmuxCommand(op),
      patch: result!.patch,
      meta: result!.meta,
    });
    const next = addPendingOp(m, pending);
    expect(next.committed.panes).toHaveLength(1); // committed untouched
    expect(next.derived.panes).toHaveLength(2); // derived has placeholder
    expect(next.derived.activePaneId).toMatch(/^__placeholder_/);
  });

  it('applyServerSnapshot drops a matched split op and records the placeholder→real mapping', () => {
    const m0 = modelFromSnapshot(snapshot());
    const op: TmuxOp = { _tag: 'Split', direction: 'vertical' };
    const result = predict(
      op,
      m0.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opSplit',
    );
    const pending = makePendingOp({
      id: 'op_split' as OpId,
      op,
      command: 'split-window -h',
      patch: result!.patch,
      meta: result!.meta,
    });
    const m1 = addPendingOp(m0, pending);
    expect(m1.derived.panes).toHaveLength(2);

    // Server sends a snapshot with both panes — placeholder gone, real pane present.
    const serverSnap = snapshot({
      panes: [
        pane({ tmuxId: '%0', width: 39 }),
        pane({ tmuxId: '%1', x: 40, width: 40, active: true }),
      ],
      activePaneId: '%1',
    });
    const reconciled = applyServerSnapshot(m1, serverSnap, 100);
    expect(reconciled.matched).toHaveLength(1);
    expect(reconciled.matched[0].realId).toBe('%1');
    expect(reconciled.model.ops).toHaveLength(0);
    expect(reconciled.model.paneKeyOverrides['%1']).toMatch(/^__placeholder_/);
    expect(reconciled.model.derived.panes.map((p) => p.tmuxId)).toEqual(['%0', '%1']);
  });

  it('stale ops get rolled back after OP_STALE_TIMEOUT_MS', () => {
    const m0 = modelFromSnapshot(snapshot());
    const op: TmuxOp = { _tag: 'Split', direction: 'vertical' };
    const result = predict(
      op,
      m0.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opStale',
    );
    const pending = makePendingOp({
      id: 'op_stale' as OpId,
      op,
      command: 'split-window -h',
      patch: result!.patch,
      meta: result!.meta,
      now: 0,
    });
    const m1 = addPendingOp(m0, pending);
    // Server snapshot still shows only the original pane — prediction unmet.
    const serverSnap = snapshot();
    // Now well past the stale timeout.
    const reconciled = applyServerSnapshot(m1, serverSnap, 10_000);
    expect(reconciled.rolledBack).toHaveLength(1);
    expect(reconciled.rolledBack[0].reason).toMatch(/stale/);
    expect(reconciled.model.ops).toHaveLength(0);
    expect(reconciled.model.derived.panes).toHaveLength(1);
  });

  it('in-flight ops survive the quick sweep but fall to the acked backstop', () => {
    const m0 = modelFromSnapshot(snapshot());
    const op: TmuxOp = { _tag: 'Split', direction: 'vertical' };
    const result = predict(
      op,
      m0.committed,
      { defaultShell: 'bash', paneActivationOrder: [] },
      'opInFlight',
    );
    const pending = makePendingOp({
      id: 'op_inflight' as OpId,
      op,
      command: 'split-window -h',
      patch: result!.patch,
      meta: result!.meta,
      now: 0,
    });
    const m1 = addPendingOp(m0, {
      ...pending,
      // The adapter call started but its ack hasn't arrived — on a slow
      // transport this alone can outlast OP_STALE_TIMEOUT_MS.
      status: 'in-flight',
    });
    const serverSnap = snapshot();
    // Past the quick sweep: the op must be kept (its call WILL settle).
    const early = applyServerSnapshot(m1, serverSnap, OP_STALE_TIMEOUT_MS + 1000);
    expect(early.rolledBack).toHaveLength(0);
    expect(early.model.ops).toHaveLength(1);
    expect(early.model.derived.panes).toHaveLength(2);
    // Past the acked backstop: swept like any wedged op.
    const late = applyServerSnapshot(m1, serverSnap, OP_ACKED_STALE_TIMEOUT_MS + 1000);
    expect(late.rolledBack).toHaveLength(1);
    expect(late.model.ops).toHaveLength(0);
  });

  it('rollbackOp synchronously removes an op and rebuilds derived', () => {
    const m0 = modelFromSnapshot(snapshot());
    const op: TmuxOp = { _tag: 'Navigate', direction: 'L' };
    // Add a second pane to the left so the predict succeeds
    const withLeft = recomputeDerived({
      ...m0,
      committed: snapshot({
        panes: [
          pane({ tmuxId: '%0', x: 40, active: true }),
          pane({ tmuxId: '%1', x: 0, width: 39 }),
        ],
      }),
    });
    const result = predict(
      op,
      withLeft.committed,
      { defaultShell: 'bash', paneActivationOrder: ['%1'] },
      'opNav',
    );
    expect(result).not.toBeNull();
    const pending = makePendingOp({
      id: 'op_nav' as OpId,
      op,
      command: 'select-pane -L',
      patch: result!.patch,
      meta: result!.meta,
    });
    const withOp = addPendingOp(withLeft, pending);
    expect(withOp.derived.activePaneId).toBe('%1');

    const { model: rolledBack, entry } = rollbackOp(withOp, 'op_nav' as OpId, 'manual cancel');
    expect(entry?.reason).toBe('manual cancel');
    expect(rolledBack.derived.activePaneId).toBe('%0');
  });

  it('parseCommandToOp recognizes the common shapes', () => {
    expect(parseCommandToOp('split-window -h')).toEqual({ _tag: 'Split', direction: 'vertical' });
    expect(parseCommandToOp('splitw -v')).toEqual({ _tag: 'Split', direction: 'horizontal' });
    expect(parseCommandToOp('select-pane -L')).toEqual({ _tag: 'Navigate', direction: 'L' });
    expect(parseCommandToOp('select-pane -t %5')).toEqual({ _tag: 'SelectPane', paneId: '%5' });
    expect(parseCommandToOp('new-window')).toEqual({ _tag: 'NewWindow' });
    expect(parseCommandToOp('next-window')).toEqual({ _tag: 'SelectWindow', target: 'next' });
    expect(parseCommandToOp('select-window -t 3')).toEqual({ _tag: 'SelectWindow', target: 3 });
    expect(parseCommandToOp('swap-pane -s %1 -t %2')).toEqual({
      _tag: 'Swap',
      sourcePaneId: '%1',
      targetPaneId: '%2',
    });
    // Unknown shapes fall through to RawCommand
    expect(parseCommandToOp('display-message hello')).toEqual({
      _tag: 'RawCommand',
      command: 'display-message hello',
    });
  });

  it('toTmuxCommand round-trips canonical ops', () => {
    expect(toTmuxCommand({ _tag: 'Split', direction: 'vertical' })).toBe('split-window -h');
    expect(toTmuxCommand({ _tag: 'Navigate', direction: 'R' })).toBe('select-pane -R');
    expect(toTmuxCommand({ _tag: 'SelectWindow', target: 'next' })).toBe('next-window');
    expect(toTmuxCommand({ _tag: 'SelectWindow', target: 5 })).toBe('select-window -t 5');
    expect(toTmuxCommand({ _tag: 'Swap', sourcePaneId: '%1', targetPaneId: '%2' })).toBe(
      'swap-pane -s %1 -t %2',
    );
  });
});
