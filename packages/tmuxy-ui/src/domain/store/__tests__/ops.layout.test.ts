import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { predict, reconcile } from '../ops';
import { parseCommandToOp } from '../parseCommand';
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
    paused: false,
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

describe('parseCommandToOp — kill / rename / zoom', () => {
  it('parses kill-pane forms', () => {
    expect(parseCommandToOp('kill-pane')).toEqual({ _tag: 'KillPane', paneId: null });
    expect(parseCommandToOp('kill-pane -t %3')).toEqual({ _tag: 'KillPane', paneId: pid('%3') });
    expect(parseCommandToOp('select-pane -t %0 \\; kill-pane')).toEqual({
      _tag: 'KillPane',
      paneId: null,
    });
  });

  it('parses kill-window forms (index targets stay raw)', () => {
    expect(parseCommandToOp('kill-window')).toEqual({ _tag: 'KillWindow', windowId: null });
    expect(parseCommandToOp('kill-window -t @2')).toEqual({
      _tag: 'KillWindow',
      windowId: wid('@2'),
    });
    expect(parseCommandToOp('kill-window -t :2')._tag).toBe('RawCommand');
  });

  it('parses rename-window forms', () => {
    expect(parseCommandToOp("rename-window -- 'my tab'")).toEqual({
      _tag: 'RenameWindow',
      target: null,
      name: 'my tab',
    });
    expect(parseCommandToOp('rename-window -t @1 newname')).toEqual({
      _tag: 'RenameWindow',
      target: wid('@1'),
      name: 'newname',
    });
  });

  it('parses zoom toggles, leaving plain resizes raw', () => {
    expect(parseCommandToOp('resize-pane -Z')).toEqual({ _tag: 'ZoomToggle', paneId: null });
    expect(parseCommandToOp('resize-pane -t %2 -Z')).toEqual({
      _tag: 'ZoomToggle',
      paneId: pid('%2'),
    });
    expect(parseCommandToOp('resize-pane -L 5')._tag).toBe('RawCommand');
  });
});

describe('KillPane predict/reconcile', () => {
  it('removes the pane, expands the aligned neighbor, refocuses MRU', () => {
    // %0 on top of %1 (same x/width, vertically adjacent).
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      panes: [pane(pid('%0'), 0, 0, 80, 10), pane(pid('%1'), 0, 11, 80, 9)],
      activePaneId: pid('%1'),
      activeWindowId: wid('@0'),
      totalWidth: 80,
      totalHeight: 20,
    };
    const op = parseCommandToOp('kill-pane -t %1');
    const result = predict(
      op,
      snap,
      { ...CTX, paneActivationOrder: [pid('%1'), pid('%0')] },
      'k1' as OpId,
    )!;
    const patched = result.patch(snap);
    expect(patched.panes.map((p) => p.tmuxId)).toEqual([pid('%0')]);
    expect(patched.panes[0].height).toBe(20); // absorbed 9 + 1 separator
    expect(patched.activePaneId).toBe(pid('%0'));

    const pendingOp = makePendingOp({
      id: 'k1' as OpId,
      op,
      command: 'kill-pane -t %1',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });
    // Pane still present → pending. Gone → CONFIRMED, but the op lingers so
    // stale pre-kill snapshots can't resurrect the pane; it releases only
    // past the linger horizon.
    const confirmed = { ...snap, panes: [snap.panes[0]] };
    expect(reconcile(pendingOp, snap, undefined, 100)._tag).toBe('pending');
    expect(reconcile(pendingOp, confirmed, undefined, 100)._tag).toBe('pending');
    expect(reconcile(pendingOp, confirmed, undefined, FOCUS_CONFIRM_LINGER_MS + 1)._tag).toBe(
      'matched',
    );
  });

  it('patch replays idempotently over confirmed layouts during the linger', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      panes: [pane(pid('%0'), 0, 0, 80, 10), pane(pid('%1'), 0, 11, 80, 9)],
      activePaneId: pid('%1'),
      activeWindowId: wid('@0'),
      totalWidth: 80,
      totalHeight: 20,
    };
    const op = parseCommandToOp('kill-pane -t %1');
    const result = predict(
      op,
      snap,
      { ...CTX, paneActivationOrder: [pid('%1'), pid('%0')] },
      'k2' as OpId,
    )!;

    // Stale pre-kill echo: doomed pane present → filter + expand absorber.
    const echoPatched = result.patch(snap);
    expect(echoPatched.panes.map((p) => p.tmuxId)).toEqual([pid('%0')]);
    expect(echoPatched.panes[0].height).toBe(20);

    // Confirmed post-kill layout: server already expanded the absorber —
    // the patch must NOT double-add the dead pane's space.
    const confirmed: TmuxSnapshot = {
      ...snap,
      panes: [pane(pid('%0'), 0, 0, 80, 20)],
      activePaneId: pid('%0'),
    };
    const replayed = result.patch(confirmed);
    expect(replayed.panes[0].height).toBe(20);
  });
});

describe('ZoomToggle predict/reconcile', () => {
  const snap: TmuxSnapshot = {
    ...EMPTY_SNAPSHOT,
    panes: [pane(pid('%0'), 0, 0, 40, 20), pane(pid('%1'), 41, 0, 40, 20)],
    activePaneId: pid('%0'),
    activeWindowId: wid('@0'),
    totalWidth: 81,
    totalHeight: 20,
  };

  it('predicts zoom-in to the window extent', () => {
    const op = parseCommandToOp('resize-pane -Z');
    const result = predict(op, snap, CTX, 'z1' as OpId)!;
    const patched = result.patch(snap);
    const zoomed = patched.panes.find((p) => p.tmuxId === pid('%0'))!;
    expect(zoomed.width).toBe(81);
    expect(zoomed.height).toBe(20);
    // Siblings untouched — mirrors the server's visible_layout behavior.
    expect(patched.panes.find((p) => p.tmuxId === pid('%1'))!.width).toBe(40);
  });

  it('does not predict unzoom (pane already at full extent)', () => {
    const zoomedSnap: TmuxSnapshot = {
      ...snap,
      panes: [pane(pid('%0'), 0, 0, 81, 20), pane(pid('%1'), 41, 0, 40, 20)],
    };
    expect(predict(parseCommandToOp('resize-pane -Z'), zoomedSnap, CTX, 'z2' as OpId)).toBeNull();
  });
});

describe('KillWindow / RenameWindow predict', () => {
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

  it('KillWindow drops the window + panes and activates the previous tab', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win(wid('@0'), 1, false), win(wid('@1'), 2, true)],
      panes: [
        pane(pid('%0'), 0, 0, 80, 20),
        { ...pane(pid('%1'), 0, 0, 80, 20), windowId: wid('@1') },
      ],
      activePaneId: pid('%1'),
      activeWindowId: wid('@1'),
    };
    snap.panes[0].windowId = wid('@0');
    const result = predict(parseCommandToOp('kill-window'), snap, CTX, 'kw1' as OpId)!;
    const patched = result.patch(snap);
    expect(patched.windows.map((w) => w.id)).toEqual([wid('@0')]);
    expect(patched.activeWindowId).toBe(wid('@0'));
    expect(patched.activePaneId).toBe(pid('%0'));
    expect(patched.panes.map((p) => p.tmuxId)).toEqual([pid('%0')]);
  });

  it('RenameWindow renames optimistically and reconciles on the server echo', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win(wid('@0'), 1, true)],
      panes: [pane(pid('%0'), 0, 0, 80, 20)],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
    };
    const op = parseCommandToOp("rename-window -- 'STORY_TAB'");
    const result = predict(op, snap, CTX, 'rn1' as OpId)!;
    expect(result.patch(snap).windows[0].name).toBe('STORY_TAB');

    const pendingOp = makePendingOp({
      id: 'rn1' as OpId,
      op,
      command: 'x',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });
    expect(reconcile(pendingOp, snap, undefined, 100)._tag).toBe('pending');
    const confirmed = { ...snap, windows: [{ ...snap.windows[0], name: 'STORY_TAB' }] };
    expect(reconcile(pendingOp, confirmed, undefined, 100)._tag).toBe('matched');
  });
});

describe('ZoomToggle supersede (rapid re-toggle)', () => {
  it('drops the zoom patch when committed shows the pre-zoom rect past the grace', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      panes: [pane(pid('%0'), 0, 0, 40, 20), pane(pid('%1'), 41, 0, 40, 20)],
      activePaneId: pid('%0'),
      activeWindowId: wid('@0'),
      totalWidth: 81,
      totalHeight: 20,
    };
    const op = parseCommandToOp('resize-pane -Z');
    const result = predict(op, snap, CTX, 'z3' as OpId)!;
    const pendingOp = makePendingOp({
      id: 'z3' as OpId,
      op,
      command: 'resize-pane -Z',
      patch: result.patch,
      meta: result.meta,
      now: 0,
    });
    // Committed still shows the pre-zoom rect (tmux coalesced a rapid
    // zoom+unzoom into no visible change): young → pending, past the
    // grace → matched so the pinned zoomed geometry can't wedge the UI.
    expect(reconcile(pendingOp, snap, undefined, 100)._tag).toBe('pending');
    expect(reconcile(pendingOp, snap, undefined, FOCUS_SUPERSEDE_GRACE_MS + 1)._tag).toBe(
      'matched',
    );
  });
});

describe('intentionally non-predicted commands', () => {
  it('break-pane and layout changes are not predicted (server-side layout math)', () => {
    for (const command of [
      'break-pane',
      'next-layout',
      'select-layout even-horizontal',
      'resize-pane -L 5',
    ]) {
      expect(predict(parseCommandToOp(command), SNAPSHOT, CTX, 'op_x' as OpId)).toBeNull();
    }
  });
});
