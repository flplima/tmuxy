import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { predict, reconcile } from '../ops';
import { parseCommandToOp } from '../parseCommand';
import { TmuxOp } from '../../commands';
import { makePendingOp } from '../model';
import {
  EMPTY_SNAPSHOT,
  FOCUS_CONFIRM_LINGER_MS,
  FOCUS_SUPERSEDE_GRACE_MS,
  type TmuxSnapshot,
  type OpId,
} from '../types';
import type { TmuxPane } from '../../client';
import type { PaneId, WindowId } from '../../ids';

function pane(tmuxId: PaneId, x: number, y: number, width: number, height: number): TmuxPane {
  return {
    id: parseInt(tmuxId.slice(1), 10),
    tmuxId,
    windowId: wid('@0'),
    content: [],
    cursorX: 0,
    cursorY: 0,
    width,
    height,
    x,
    y,
    active: false,
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
  };
}

// Two side-by-side panes: %0 [0..39] and %1 [41..80].
const SNAPSHOT: TmuxSnapshot = {
  ...EMPTY_SNAPSHOT,
  panes: [pane(pid('%0'), 0, 0, 40, 20), pane(pid('%1'), 41, 0, 40, 20)],
  activePaneId: pid('%0'),
  activeWindowId: wid('@0'),
  totalWidth: 81,
  totalHeight: 20,
};

const CTX = { defaultShell: 'bash', paneActivationOrder: [] as PaneId[] };

function focusOp(now: number) {
  const op = parseCommandToOp('select-pane -t %1');
  const result = predict(op, SNAPSHOT, CTX, 'op_test' as OpId)!;
  return makePendingOp({
    id: 'op_test' as OpId,
    op,
    command: 'select-pane -t %1',
    patch: result.patch,
    meta: result.meta,
    now,
  });
}

describe('reconcileFocus — linger and supersession', () => {
  const t0 = 1_000_000;

  it('holds a confirmed focus op until the linger expires, then matches', () => {
    const op = focusOp(t0);
    const confirmed: TmuxSnapshot = { ...SNAPSHOT, activePaneId: pid('%1') };
    expect(reconcile(op, confirmed, undefined, t0 + 100)._tag).toBe('pending');
    expect(reconcile(op, confirmed, undefined, t0 + FOCUS_CONFIRM_LINGER_MS + 1)._tag).toBe(
      'matched',
    );
  });

  it('holds through stale echoes of the pre-op focus', () => {
    const op = focusOp(t0);
    const staleEcho: TmuxSnapshot = { ...SNAPSHOT, activePaneId: pid('%0') };
    // Even past the supersede grace — %0 is what was active when we predicted,
    // so this is a stale snapshot, not a new focus.
    expect(reconcile(op, staleEcho, undefined, t0 + FOCUS_SUPERSEDE_GRACE_MS + 500)._tag).toBe(
      'pending',
    );
  });

  it('holds briefly, then yields, when a THIRD pane takes focus', () => {
    const op = focusOp(t0);
    const superseded: TmuxSnapshot = {
      ...SNAPSHOT,
      panes: [...SNAPSHOT.panes, pane(pid('%2'), 0, 21, 81, 10)],
      activePaneId: pid('%2'),
    };
    // Young: server may not have processed us yet.
    expect(reconcile(op, superseded, undefined, t0 + 100)._tag).toBe('pending');
    // Past the grace: the server moved focus elsewhere — it wins.
    expect(reconcile(op, superseded, undefined, t0 + FOCUS_SUPERSEDE_GRACE_MS + 1)._tag).toBe(
      'matched',
    );
  });
});

describe('MoveWindow predict (tab reorder)', () => {
  const win = (id: WindowId, index: number) => ({
    id,
    index,
    name: `w${index}`,
    active: index === 1,
    windowType: 'tab' as const,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });
  const snap: TmuxSnapshot = {
    ...EMPTY_SNAPSHOT,
    windows: [win(wid('@0'), 1), win(wid('@1'), 2), win(wid('@2'), 3)],
    activeWindowId: wid('@0'),
  };
  const order = (s: TmuxSnapshot) => s.windows.map((w) => w.id);

  it('shows the dropped order at once, numbered in strip order, and holds it until tmux agrees', () => {
    const op = TmuxOp.MoveWindow({ windowId: wid('@2'), anchorId: wid('@0'), placement: 'before' });
    const result = predict(op, snap, CTX, 'mv1' as OpId)!;
    const patched = result.patch(snap);
    expect(order(patched)).toEqual([wid('@2'), wid('@0'), wid('@1')]);
    expect(patched.windows.map((w) => w.index)).toEqual([1, 2, 3]);

    const pendingOp = makePendingOp({
      id: 'mv1' as OpId,
      op,
      command: 'x',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });
    // tmux has not echoed the move: the old order is not the answer.
    expect(reconcile(pendingOp, snap, undefined, 100)._tag).toBe('pending');
    expect(reconcile(pendingOp, patched, undefined, 100)._tag).toBe('matched');
    // The window went away meanwhile: nothing left to wait for.
    const gone = { ...snap, windows: snap.windows.filter((w) => w.id !== wid('@2')) };
    expect(reconcile(pendingOp, gone, undefined, 100)._tag).toBe('matched');
  });

  it('moves after an anchor too, and predicts nothing for a window tmux does not have', () => {
    const after = predict(
      TmuxOp.MoveWindow({ windowId: wid('@0'), anchorId: wid('@1'), placement: 'after' }),
      snap,
      CTX,
      'mv2' as OpId,
    )!;
    expect(order(after.patch(snap))).toEqual([wid('@1'), wid('@0'), wid('@2')]);
    expect(
      predict(
        TmuxOp.MoveWindow({ windowId: wid('@7'), anchorId: wid('@0'), placement: 'before' }),
        snap,
        CTX,
        'mv3' as OpId,
      ),
    ).toBe(null);
  });
});

describe('SelectWindow predicts even when the target window has no known panes', () => {
  // Background windows can arrive pane-less on some transports; bailing on
  // the prediction left the whole switch unpinned, and pre-confirm snapshots
  // flapped the tab strip back.
  const win = (id: WindowId, index: number, active: boolean) => ({
    id,
    index,
    name: `w${index}`,
    active,
    windowType: 'tab' as const,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });
  const snap: TmuxSnapshot = {
    ...SNAPSHOT,
    windows: [win(wid('@0'), 0, true), win(wid('@1'), 1, false)],
  };

  it('resolves a target given by window id, which is what the client sends', () => {
    const op = parseCommandToOp('select-window -t @1');
    const result = predict(op, snap, CTX, 'op_selwin_id' as OpId);
    expect(result).not.toBeNull();
    expect(result!.patch(snap).activeWindowId).toBe(wid('@1'));
  });

  it('pins the window flip immediately and resolves the pane when it arrives', () => {
    const op = parseCommandToOp('select-window -t 1');
    const result = predict(op, snap, CTX, 'op_selwin' as OpId);
    expect(result).not.toBeNull();

    // Replayed on the paneless snapshot: window flips, pane focus unchanged.
    const flipped = result!.patch(snap);
    expect(flipped.activeWindowId).toBe(wid('@1'));
    expect(flipped.windows.find((w) => w.id === wid('@1'))!.active).toBe(true);
    expect(flipped.activePaneId).toBe(pid('%0'));

    // Replayed after the target's pane lands: the patch resolves it.
    const withPane: TmuxSnapshot = {
      ...snap,
      panes: [
        ...snap.panes,
        { ...pane(pid('%9'), 0, 0, 80, 20), windowId: wid('@1'), active: true },
      ],
    };
    const resolved = result!.patch(withPane);
    expect(resolved.activePaneId).toBe(pid('%9'));
  });

  it("lands on the target window's own active pane, not its first pane", () => {
    // `pane.active` is session-wide: none of a background tab's panes carry
    // it. The window's own activePaneId (from the server) is what the switch
    // must use — the first pane was a wrong guess the server then corrected.
    const target = { ...win(wid('@1'), 1, false), activePaneId: pid('%36') };
    const background: TmuxSnapshot = {
      ...snap,
      windows: [win(wid('@0'), 0, true), target],
      panes: [
        ...snap.panes,
        { ...pane(pid('%35'), 0, 0, 40, 20), windowId: wid('@1') },
        { ...pane(pid('%36'), 40, 0, 40, 20), windowId: wid('@1') },
      ],
    };
    const result = predict(
      TmuxOp.SelectWindow({ target: wid('@1') }),
      background,
      CTX,
      'op_own' as OpId,
    );
    expect(result!.patch(background).activePaneId).toBe(pid('%36'));
  });
});

describe('NewWindow reconcile requires the window to have a pane', () => {
  const win = (id: WindowId, index: number, windowType: 'tab' | null) => ({
    id,
    index,
    name: `w${index}`,
    active: false,
    windowType,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });

  it('stays pending until the new tab window has a pane (guards placeholder remount)', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win(wid('@0'), 1, 'tab')],
      panes: [pane(pid('%0'), 0, 0, 80, 20)],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
    };
    const op = parseCommandToOp('new-window');
    const result = predict(op, snap, CTX, 'nw1' as OpId)!;
    const pendingOp = makePendingOp({
      id: 'nw1' as OpId,
      op,
      command: 'new-window',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });

    // Real window @1 tagged 'tab' but its pane hasn't been remapped yet
    // (break-pane emits %window-add before the moved pane's window settles).
    const windowNoPane: TmuxSnapshot = {
      ...snap,
      windows: [win(wid('@0'), 1, 'tab'), win(wid('@1'), 2, 'tab')],
      // %1 still parented to @0 (not yet moved to @1)
      panes: [
        pane(pid('%0'), 0, 0, 80, 20),
        { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@0') },
      ],
    };
    expect(reconcile(pendingOp, windowNoPane, undefined, 100)._tag).toBe('pending');

    // Pane now in @1 → matches, so the pane-key override maps it (no remount).
    const windowWithPane: TmuxSnapshot = {
      ...windowNoPane,
      panes: [
        pane(pid('%0'), 0, 0, 80, 20),
        { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@1') },
      ],
    };
    const verdict = reconcile(pendingOp, windowWithPane, undefined, 100);
    expect(verdict._tag).toBe('matched');
    expect(verdict._tag === 'matched' && verdict.realWindowId).toBe(wid('@1'));
  });

  it('patch hides a tab-typed-but-paneless newborn so it does not render as a 2nd tab', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win(wid('@0'), 1, 'tab')],
      panes: [pane(pid('%0'), 0, 0, 80, 20)],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
    };
    const { patch } = predict(parseCommandToOp('new-window'), snap, CTX, 'nw2' as OpId)!;

    // Real window @1 tagged 'tab' but still paneless (break-pane sets the type
    // tag a beat before the moved pane's window settles). Rendering it now would
    // show a duplicate tab beside the placeholder that blinks away next tick.
    const paneless: TmuxSnapshot = {
      ...snap,
      windows: [win(wid('@0'), 1, 'tab'), win(wid('@1'), 2, 'tab')],
      panes: [
        pane(pid('%0'), 0, 0, 80, 20),
        { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@0') },
      ],
    };
    const hiddenIds = patch(paneless).windows.map((w) => w.id);
    expect(hiddenIds).not.toContain(wid('@1')); // the newborn tab is hidden…
    expect(hiddenIds.filter((id) => id.startsWith('__placeholder_'))).toHaveLength(1); // …placeholder stands in

    // Once @1 owns its pane it is renderable; the patch keeps it (reconcile
    // matches it the same tick and swaps the placeholder out — no duplicate).
    const withPane: TmuxSnapshot = {
      ...paneless,
      panes: [
        pane(pid('%0'), 0, 0, 80, 20),
        { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@1') },
      ],
    };
    expect(patch(withPane).windows.map((w) => w.id)).toContain(wid('@1'));
  });
});

describe('JoinPane moves a pane into another tab ahead of tmux', () => {
  const win = (id: WindowId, index: number, active: boolean) => ({
    id,
    index,
    name: `w${index}`,
    active,
    windowType: 'tab' as const,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });
  const target = { ...pane(pid('%5'), 0, 0, 81, 20), windowId: wid('@1') };
  const snap: TmuxSnapshot = {
    ...SNAPSHOT,
    windows: [win(wid('@0'), 0, true), { ...win(wid('@1'), 1, false), activePaneId: pid('%5') }],
    panes: [...SNAPSHOT.panes, target],
  };
  const join = TmuxOp.JoinPane({ paneId: pid('%1'), windowId: wid('@1') });

  it('leaves its window to its neighbour and splits the target’s active pane below it', () => {
    const moved = predict(join, snap, CTX, 'op_join' as OpId)!.patch(snap);
    const byId = (id: PaneId) => moved.panes.find((p) => p.tmuxId === id)!;
    expect(byId(pid('%0'))).toMatchObject({ x: 0, width: 81 });
    expect(byId(pid('%5'))).toMatchObject({ y: 0, height: 9 });
    expect(byId(pid('%1'))).toMatchObject({
      windowId: wid('@1'),
      x: 0,
      y: 10,
      width: 81,
      height: 10,
    });
    expect(moved.windows.find((w) => w.id === wid('@1'))!.activePaneId).toBe(pid('%1'));
  });

  it('waits until tmux lists the pane in the target window', () => {
    const result = predict(join, snap, CTX, 'op_join' as OpId)!;
    const pending = makePendingOp({
      id: 'op_join' as OpId,
      op: join,
      command: 'join-pane -s %1 -t @1',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });
    expect(reconcile(pending, snap, undefined, 10_000)._tag).toBe('pending');
    const joined = result.patch(snap);
    expect(reconcile(pending, joined, undefined, 10_000)._tag).toBe('matched');
  });
});

describe('KillWindow on the current tab lands where tmux will', () => {
  const win = (id: WindowId, index: number, active: boolean) => ({
    id,
    index,
    name: `w${index}`,
    active,
    windowType: 'tab' as const,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });
  const snap: TmuxSnapshot = {
    ...SNAPSHOT,
    windows: [win(wid('@0'), 0, false), win(wid('@1'), 1, false), win(wid('@2'), 2, true)],
    panes: [
      { ...pane(pid('%0'), 0, 0, 80, 20), windowId: wid('@0') },
      { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@1') },
      { ...pane(pid('%2'), 0, 0, 80, 20), windowId: wid('@2'), active: true },
    ],
    activeWindowId: wid('@2'),
    activePaneId: pid('%2'),
  };
  const kill = TmuxOp.KillWindow({ windowId: wid('@2') });

  it('the tab used last, as tmux’s own last-window choice', () => {
    const ctx = { ...CTX, paneActivationOrder: [pid('%2'), pid('%0'), pid('%1')] };
    const after = predict(kill, snap, ctx, 'op_kw' as OpId)!.patch(snap);
    expect(after.activeWindowId).toBe(wid('@0'));
  });

  it('the previous tab when nothing says which was used last', () => {
    const after = predict(kill, snap, CTX, 'op_kw' as OpId)!.patch(snap);
    expect(after.activeWindowId).toBe(wid('@1'));
  });
});
