/**
 * Unit tests for per-op predict/reconcile logic — currently the focus-op
 * (SelectPane / Navigate) reconcile semantics: confirm-linger, stale-echo
 * holding, and supersession, plus the tmuxy-nav-* alias parsing.
 */

import { describe, it, expect } from 'vitest';
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
import type { TmuxPane } from '../../types';

function pane(tmuxId: string, x: number, y: number, width: number, height: number): TmuxPane {
  return {
    id: parseInt(tmuxId.slice(1), 10),
    tmuxId,
    windowId: '@0',
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
  panes: [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 40, 20)],
  activePaneId: '%0',
  activeWindowId: '@0',
  totalWidth: 81,
  totalHeight: 20,
};

const CTX = { defaultShell: 'bash', paneActivationOrder: [] as string[] };

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

describe('parseCommandToOp — tmuxy-nav aliases', () => {
  it('maps tmuxy-nav-* to Navigate ops', () => {
    expect(parseCommandToOp('tmuxy-nav-left')).toEqual({ _tag: 'Navigate', direction: 'L' });
    expect(parseCommandToOp('tmuxy-nav-right')).toEqual({ _tag: 'Navigate', direction: 'R' });
    expect(parseCommandToOp('tmuxy-nav-up')).toEqual({ _tag: 'Navigate', direction: 'U' });
    expect(parseCommandToOp('tmuxy-nav-down')).toEqual({ _tag: 'Navigate', direction: 'D' });
  });

  it('maps the pinned compound form too', () => {
    expect(parseCommandToOp('select-pane -t %0 \\; tmuxy-nav-right')).toEqual({
      _tag: 'Navigate',
      direction: 'R',
    });
  });
});

describe('reconcileFocus — linger and supersession', () => {
  const t0 = 1_000_000;

  it('holds a confirmed focus op until the linger expires, then matches', () => {
    const op = focusOp(t0);
    const confirmed: TmuxSnapshot = { ...SNAPSHOT, activePaneId: '%1' };
    expect(reconcile(op, confirmed, undefined, t0 + 100)._tag).toBe('pending');
    expect(reconcile(op, confirmed, undefined, t0 + FOCUS_CONFIRM_LINGER_MS + 1)._tag).toBe(
      'matched',
    );
  });

  it('holds through stale echoes of the pre-op focus', () => {
    const op = focusOp(t0);
    const staleEcho: TmuxSnapshot = { ...SNAPSHOT, activePaneId: '%0' };
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
      panes: [...SNAPSHOT.panes, pane('%2', 0, 21, 81, 10)],
      activePaneId: '%2',
    };
    // Young: server may not have processed us yet.
    expect(reconcile(op, superseded, undefined, t0 + 100)._tag).toBe('pending');
    // Past the grace: the server moved focus elsewhere — it wins.
    expect(reconcile(op, superseded, undefined, t0 + FOCUS_SUPERSEDE_GRACE_MS + 1)._tag).toBe(
      'matched',
    );
  });
});

describe('parseCommandToOp — kill / rename / zoom', () => {
  it('parses kill-pane forms', () => {
    expect(parseCommandToOp('kill-pane')).toEqual({ _tag: 'KillPane', paneId: null });
    expect(parseCommandToOp('kill-pane -t %3')).toEqual({ _tag: 'KillPane', paneId: '%3' });
    expect(parseCommandToOp('select-pane -t %0 \\; kill-pane')).toEqual({
      _tag: 'KillPane',
      paneId: null,
    });
  });

  it('parses kill-window forms (index targets stay raw)', () => {
    expect(parseCommandToOp('kill-window')).toEqual({ _tag: 'KillWindow', windowId: null });
    expect(parseCommandToOp('kill-window -t @2')).toEqual({ _tag: 'KillWindow', windowId: '@2' });
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
      target: '@1',
      name: 'newname',
    });
  });

  it('parses zoom toggles, leaving plain resizes raw', () => {
    expect(parseCommandToOp('resize-pane -Z')).toEqual({ _tag: 'ZoomToggle', paneId: null });
    expect(parseCommandToOp('resize-pane -t %2 -Z')).toEqual({ _tag: 'ZoomToggle', paneId: '%2' });
    expect(parseCommandToOp('resize-pane -L 5')._tag).toBe('RawCommand');
  });
});

describe('KillPane predict/reconcile', () => {
  it('removes the pane, expands the aligned neighbor, refocuses MRU', () => {
    // %0 on top of %1 (same x/width, vertically adjacent).
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      panes: [pane('%0', 0, 0, 80, 10), pane('%1', 0, 11, 80, 9)],
      activePaneId: '%1',
      activeWindowId: '@0',
      totalWidth: 80,
      totalHeight: 20,
    };
    const op = parseCommandToOp('kill-pane -t %1');
    const result = predict(op, snap, { ...CTX, paneActivationOrder: ['%1', '%0'] }, 'k1' as OpId)!;
    const patched = result.patch(snap);
    expect(patched.panes.map((p) => p.tmuxId)).toEqual(['%0']);
    expect(patched.panes[0].height).toBe(20); // absorbed 9 + 1 separator
    expect(patched.activePaneId).toBe('%0');

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
      panes: [pane('%0', 0, 0, 80, 10), pane('%1', 0, 11, 80, 9)],
      activePaneId: '%1',
      activeWindowId: '@0',
      totalWidth: 80,
      totalHeight: 20,
    };
    const op = parseCommandToOp('kill-pane -t %1');
    const result = predict(op, snap, { ...CTX, paneActivationOrder: ['%1', '%0'] }, 'k2' as OpId)!;

    // Stale pre-kill echo: doomed pane present → filter + expand absorber.
    const echoPatched = result.patch(snap);
    expect(echoPatched.panes.map((p) => p.tmuxId)).toEqual(['%0']);
    expect(echoPatched.panes[0].height).toBe(20);

    // Confirmed post-kill layout: server already expanded the absorber —
    // the patch must NOT double-add the dead pane's space.
    const confirmed: TmuxSnapshot = {
      ...snap,
      panes: [pane('%0', 0, 0, 80, 20)],
      activePaneId: '%0',
    };
    const replayed = result.patch(confirmed);
    expect(replayed.panes[0].height).toBe(20);
  });
});

describe('ZoomToggle predict/reconcile', () => {
  const snap: TmuxSnapshot = {
    ...EMPTY_SNAPSHOT,
    panes: [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 40, 20)],
    activePaneId: '%0',
    activeWindowId: '@0',
    totalWidth: 81,
    totalHeight: 20,
  };

  it('predicts zoom-in to the window extent', () => {
    const op = parseCommandToOp('resize-pane -Z');
    const result = predict(op, snap, CTX, 'z1' as OpId)!;
    const patched = result.patch(snap);
    const zoomed = patched.panes.find((p) => p.tmuxId === '%0')!;
    expect(zoomed.width).toBe(81);
    expect(zoomed.height).toBe(20);
    // Siblings untouched — mirrors the server's visible_layout behavior.
    expect(patched.panes.find((p) => p.tmuxId === '%1')!.width).toBe(40);
  });

  it('does not predict unzoom (pane already at full extent)', () => {
    const zoomedSnap: TmuxSnapshot = {
      ...snap,
      panes: [pane('%0', 0, 0, 81, 20), pane('%1', 41, 0, 40, 20)],
    };
    expect(predict(parseCommandToOp('resize-pane -Z'), zoomedSnap, CTX, 'z2' as OpId)).toBeNull();
  });
});

describe('KillWindow / RenameWindow predict', () => {
  const win = (id: string, index: number, active: boolean) => ({
    id,
    index,
    name: `w${index}`,
    active,
    windowType: 'tab' as const,
    groupPanes: null,
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
      windows: [win('@0', 1, false), win('@1', 2, true)],
      panes: [pane('%0', 0, 0, 80, 20), { ...pane('%1', 0, 0, 80, 20), windowId: '@1' }],
      activePaneId: '%1',
      activeWindowId: '@1',
    };
    snap.panes[0].windowId = '@0';
    const result = predict(parseCommandToOp('kill-window'), snap, CTX, 'kw1' as OpId)!;
    const patched = result.patch(snap);
    expect(patched.windows.map((w) => w.id)).toEqual(['@0']);
    expect(patched.activeWindowId).toBe('@0');
    expect(patched.activePaneId).toBe('%0');
    expect(patched.panes.map((p) => p.tmuxId)).toEqual(['%0']);
  });

  it('RenameWindow renames optimistically and reconciles on the server echo', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win('@0', 1, true)],
      panes: [pane('%0', 0, 0, 80, 20)],
      activePaneId: '%0',
      activeWindowId: '@0',
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
      panes: [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 40, 20)],
      activePaneId: '%0',
      activeWindowId: '@0',
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

describe('SelectWindow predicts even when the target window has no known panes', () => {
  // Background windows can arrive pane-less on some transports; bailing on
  // the prediction left the whole switch unpinned, and pre-confirm snapshots
  // flapped the tab strip back (masked, pre-refactor, by a machine-level
  // grace pin that no longer exists).
  const win = (id: string, index: number, active: boolean) => ({
    id,
    index,
    name: `w${index}`,
    active,
    windowType: 'tab' as const,
    groupPanes: null,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  });
  const snap: TmuxSnapshot = {
    ...SNAPSHOT,
    windows: [win('@0', 0, true), win('@1', 1, false)],
  };

  it('pins the window flip immediately and resolves the pane when it arrives', () => {
    const op = parseCommandToOp('select-window -t 1');
    const result = predict(op, snap, CTX, 'op_selwin' as OpId);
    expect(result).not.toBeNull();

    // Replayed on the paneless snapshot: window flips, pane focus unchanged.
    const flipped = result!.patch(snap);
    expect(flipped.activeWindowId).toBe('@1');
    expect(flipped.windows.find((w) => w.id === '@1')!.active).toBe(true);
    expect(flipped.activePaneId).toBe('%0');

    // Replayed after the target's pane lands: the patch resolves it.
    const withPane: TmuxSnapshot = {
      ...snap,
      panes: [...snap.panes, { ...pane('%9', 0, 0, 80, 20), windowId: '@1', active: true }],
    };
    const resolved = result!.patch(withPane);
    expect(resolved.activePaneId).toBe('%9');
  });
});

describe('intentionally non-predicted commands', () => {
  it('break-pane and layout cycling stay RawCommand (server-side layout math)', () => {
    expect(parseCommandToOp('break-pane')._tag).toBe('RawCommand');
    expect(parseCommandToOp('next-layout')._tag).toBe('RawCommand');
    expect(parseCommandToOp('select-layout even-horizontal')._tag).toBe('RawCommand');
    expect(parseCommandToOp('resize-pane -L 5')._tag).toBe('RawCommand');
  });
});

describe('NewWindow reconcile requires the window to have a pane', () => {
  const win = (id: string, index: number, windowType: 'tab' | null) => ({
    id,
    index,
    name: `w${index}`,
    active: false,
    windowType,
    groupPanes: null,
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
      windows: [win('@0', 1, 'tab')],
      panes: [pane('%0', 0, 0, 80, 20)],
      activePaneId: '%0',
      activeWindowId: '@0',
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
      windows: [win('@0', 1, 'tab'), win('@1', 2, 'tab')],
      // %1 still parented to @0 (not yet moved to @1)
      panes: [pane('%0', 0, 0, 80, 20), { ...pane('%1', 0, 0, 80, 20), windowId: '@0' }],
    };
    expect(reconcile(pendingOp, windowNoPane, undefined, 100)._tag).toBe('pending');

    // Pane now in @1 → matches, so the pane-key override maps it (no remount).
    const windowWithPane: TmuxSnapshot = {
      ...windowNoPane,
      panes: [pane('%0', 0, 0, 80, 20), { ...pane('%1', 0, 0, 80, 20), windowId: '@1' }],
    };
    const verdict = reconcile(pendingOp, windowWithPane, undefined, 100);
    expect(verdict._tag).toBe('matched');
    expect(verdict._tag === 'matched' && verdict.realId).toBe('@1');
  });

  it('patch hides a tab-typed-but-paneless newborn so it does not render as a 2nd tab', () => {
    const snap: TmuxSnapshot = {
      ...EMPTY_SNAPSHOT,
      windows: [win('@0', 1, 'tab')],
      panes: [pane('%0', 0, 0, 80, 20)],
      activePaneId: '%0',
      activeWindowId: '@0',
    };
    const { patch } = predict(parseCommandToOp('new-window'), snap, CTX, 'nw2' as OpId)!;

    // Real window @1 tagged 'tab' but still paneless (break-pane sets the type
    // tag a beat before the moved pane's window settles). Rendering it now would
    // show a duplicate tab beside the placeholder that blinks away next tick.
    const paneless: TmuxSnapshot = {
      ...snap,
      windows: [win('@0', 1, 'tab'), win('@1', 2, 'tab')],
      panes: [pane('%0', 0, 0, 80, 20), { ...pane('%1', 0, 0, 80, 20), windowId: '@0' }],
    };
    const hiddenIds = patch(paneless).windows.map((w) => w.id);
    expect(hiddenIds).not.toContain('@1'); // the newborn tab is hidden…
    expect(hiddenIds.filter((id) => id.startsWith('__placeholder_'))).toHaveLength(1); // …placeholder stands in

    // Once @1 owns its pane it is renderable; the patch keeps it (reconcile
    // matches it the same tick and swaps the placeholder out — no duplicate).
    const withPane: TmuxSnapshot = {
      ...paneless,
      panes: [pane('%0', 0, 0, 80, 20), { ...pane('%1', 0, 0, 80, 20), windowId: '@1' }],
    };
    expect(patch(withPane).windows.map((w) => w.id)).toContain('@1');
  });
});
