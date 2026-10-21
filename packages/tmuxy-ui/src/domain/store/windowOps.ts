import type { TmuxSnapshot, Patch, ReconcileVerdict } from './types';
import { lingerVerdict } from './types';
import type { TmuxPane, TmuxWindow } from '../client';
import type { TmuxOpOf } from '../commands';
import {
  isPlaceholderId,
  placeholderPaneId as newPlaceholderPaneId,
  placeholderWindowId as newPlaceholderWindowId,
  type PaneId,
  type WindowId,
} from '../ids';
import type { PredictContext, PredictResult } from './ops';
import { makePlaceholderPane } from './paneOps';

// ============================================
// NewWindow
// ============================================

export function predictNewWindow(
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult {
  const maxIndex = snapshot.windows.reduce((m, w) => Math.max(m, w.index), -1);
  const placeholderWindowId = newPlaceholderWindowId(opId);
  const placeholderPaneId = newPlaceholderPaneId(`pane_${opId}`);
  const placeholderWindow: TmuxWindow = {
    id: placeholderWindowId,
    index: maxIndex + 1,
    name: `Window ${maxIndex + 1}`,
    active: true,
    windowType: 'tab',
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
    zoomed: false,
  };
  // Size the placeholder pane to the current viewport so the new tab renders
  // full-width immediately instead of waiting for the server's resize delta.
  // Fall back to the active pane's window dimensions if totalWidth/Height
  // aren't populated yet (initial-load case).
  let cols = snapshot.totalWidth;
  let rows = snapshot.totalHeight;
  if (cols <= 0 || rows <= 0) {
    const activeWindow = snapshot.windows.find((w) => w.id === snapshot.activeWindowId);
    const sibling = snapshot.panes.find((p) => p.windowId === activeWindow?.id);
    if (sibling) {
      cols = sibling.x + sibling.width;
      rows = sibling.y + sibling.height;
    }
  }
  const placeholderPane: TmuxPane = makePlaceholderPane(
    placeholderPaneId,
    placeholderWindowId,
    ctx.defaultShell,
    { x: 0, y: 0, width: cols, height: rows },
  );

  const priorWindowIds = snapshot.windows.map((w) => w.id);

  const patch: Patch = (s) => {
    // A newborn window is only safe to render once reconcileNewWindow would
    // MATCH it: tab-typed AND it already owns a pane. Hide every other newborn
    // the server has reported but no op has claimed yet — the placeholder tab
    // stands in for it until then. This must mirror the reconcile match
    // condition exactly, or a gap opens: `break-pane` sets the window's
    // `@tmuxy-window-type` tag a beat BEFORE the moved pane's window_id settles,
    // so a tab-typed-but-paneless window would otherwise render as a SECOND tab
    // next to the placeholder (a duplicate tab that blinks away on the next
    // snapshot). A pane can even arrive a snapshot before its window record —
    // hide those too.
    const isRenderableTab = (w: TmuxWindow): boolean =>
      w.windowType === 'tab' && s.panes.some((p) => p.windowId === w.id);
    const unclaimedNewborns = new Set(
      s.windows
        .filter(
          (w) => !priorWindowIds.includes(w.id) && !isPlaceholderId(w.id) && !isRenderableTab(w),
        )
        .map((w) => w.id),
    );
    const knownWindowIds = new Set(s.windows.map((w) => w.id));
    const isNewbornPane = (p: TmuxPane): boolean => {
      if (priorWindowIds.includes(p.windowId)) return false;
      if (p.windowId === placeholderWindowId || isPlaceholderId(p.windowId)) return false;
      return unclaimedNewborns.has(p.windowId) || !knownWindowIds.has(p.windowId);
    };
    const windows = s.windows.filter((w) => !unclaimedNewborns.has(w.id));
    const panes = s.panes.filter((p) => !isNewbornPane(p));
    return {
      ...s,
      windows: [...windows.map((w) => ({ ...w, active: false })), placeholderWindow],
      panes: [...panes, placeholderPane],
      activeWindowId: placeholderWindowId,
      activePaneId: placeholderPaneId,
    };
  };

  return {
    patch,
    meta: { placeholderWindowId, placeholderPaneId, priorWindowIds },
  };
}

export function reconcileNewWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
  panes: ReadonlyArray<TmuxPane>,
  /** Real window ids already claimed by earlier pending NewWindow ops. */
  claimedRealIds: ReadonlySet<PaneId | WindowId>,
): ReconcileVerdict {
  const prior = new Set(meta.priorWindowIds as WindowId[]);
  if (windows.length === 0) return { _tag: 'pending' };
  const candidate = windows.find(
    (w) =>
      !prior.has(w.id) &&
      !isPlaceholderId(w.id) &&
      !claimedRealIds.has(w.id) &&
      w.windowType === 'tab' &&
      // The window must already have a pane. break-pane emits %window-add (and
      // the window's type tag) a beat before the moved pane's window_id
      // settles, so matching on the bare window would install the
      // placeholder→real pane-key override against a window with no pane —
      // and the real pane then mounts fresh (a remount/flicker) instead of
      // morphing from the placeholder. Waiting for the pane lets the override
      // map it and keep the React key stable.
      panes.some((p) => p.windowId === w.id),
  );
  if (candidate) return { _tag: 'matched', realWindowId: candidate.id };
  return { _tag: 'pending' };
}

// ============================================
// SelectWindow (tab switch)
// ============================================

export function predictSelectWindow(
  op: TmuxOpOf<'SelectWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (!snapshot.activeWindowId) return null;
  const visible = snapshot.windows.filter((w) => w.windowType === 'tab');
  if (visible.length === 0) return null;

  let target: TmuxWindow | undefined;
  if (typeof op.target === 'number') {
    target = visible.find((w) => w.index === op.target);
  } else if (op.target.startsWith('@')) {
    target = visible.find((w) => w.id === op.target);
  } else {
    const currentIdx = visible.findIndex((w) => w.id === snapshot.activeWindowId);
    if (currentIdx === -1) return null;
    const delta = op.target === 'next' ? 1 : -1;
    target = visible[(currentIdx + delta + visible.length) % visible.length];
  }
  if (!target || target.id === snapshot.activeWindowId) return null;

  const targetId = target.id;
  // Flip windows[].active too — the tab strip renders aria-selected from the
  // per-window flag, not from activeWindowId, and must flip in the same patch.
  // Self-neutralizes if the target window disappears (killed mid-linger).
  //
  // The active pane is derived INSIDE the patch, from whatever snapshot the
  // patch is replayed onto: the target window's panes may be entirely unknown
  // at predict time (background windows can arrive pane-less on some
  // transports), and bailing here would leave the whole switch unpinned —
  // stale pre-confirm snapshots then flap the tab strip back. When the panes
  // land, the same patch resolves the right active pane on that replay.
  const patch: Patch = (s) => {
    if (!s.windows.some((w) => w.id === targetId)) return s;
    const targetPanes = s.panes.filter((p) => p.windowId === targetId);
    // The window's own active pane first: `pane.active` is session-wide, so
    // a background tab's panes never carry it.
    const ownActive = s.windows.find((w) => w.id === targetId)?.activePaneId;
    const activeInTarget =
      targetPanes.find((p) => p.tmuxId === ownActive) ??
      targetPanes.find((p) => p.active) ??
      targetPanes[0];
    return {
      ...s,
      windows: s.windows.map((w) => ({ ...w, active: w.id === targetId })),
      activeWindowId: targetId,
      activePaneId: activeInTarget?.tmuxId ?? s.activePaneId,
    };
  };

  return {
    patch,
    meta: {
      targetWindowId: targetId,
      previousActiveWindowId: snapshot.activeWindowId,
    },
  };
}

/**
 * Same linger/supersede semantics as reconcileFocus: stale snapshots computed
 * before the switch flap the tab strip if the pin drops on first confirmation.
 */
export function reconcileSelectWindow(
  meta: Readonly<Record<string, unknown>>,
  serverActiveWindowId: WindowId | null,
  ageMs: number,
  committedWindows?: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const target = meta.targetWindowId as WindowId;
  const previous = meta.previousActiveWindowId as WindowId | null | undefined;
  if (committedWindows && !committedWindows.some((w) => w.id === target)) {
    // The target window is gone — nothing left to pin.
    return { _tag: 'matched' };
  }
  return lingerVerdict(target, previous, serverActiveWindowId, ageMs);
}

// ============================================
// KillWindow
// ============================================

export function predictKillWindow(
  op: TmuxOpOf<'KillWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const windowId = op.windowId ?? snapshot.activeWindowId;
  if (!windowId || isPlaceholderId(windowId)) return null;
  const doomed = snapshot.windows.find((w) => w.id === windowId);
  if (!doomed) return null;

  const tabs = snapshot.windows.filter((w) => w.windowType === 'tab' && w.id !== windowId);
  // tmux activates an adjacent window; approximate with the previous tab by
  // index, falling back to the next. The reconciler only requires the window
  // to be gone, so a different server choice self-corrects on confirm.
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const nextActive =
    snapshot.activeWindowId === windowId
      ? ([...sorted].reverse().find((w) => w.index < doomed.index) ??
        sorted.find((w) => w.index > doomed.index) ??
        null)
      : null;

  const patch: Patch = (s) => {
    const windows = s.windows
      .filter((w) => w.id !== windowId)
      .map((w) => (nextActive ? { ...w, active: w.id === nextActive.id } : w));
    const panes = s.panes.filter((p) => p.windowId !== windowId);
    let activeWindowId = s.activeWindowId;
    let activePaneId = s.activePaneId;
    if (s.activeWindowId === windowId) {
      activeWindowId = nextActive?.id ?? null;
      const targetPanes = panes.filter((p) => p.windowId === activeWindowId);
      activePaneId = (targetPanes.find((p) => p.active) ?? targetPanes[0])?.tmuxId ?? null;
    }
    return { ...s, windows, panes, activeWindowId, activePaneId };
  };

  return { patch, meta: { killedWindowId: windowId } };
}

export function reconcileKillWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const killed = meta.killedWindowId as WindowId;
  if (!windows.some((w) => w.id === killed)) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

// ============================================
// RenameWindow
// ============================================

export function predictRenameWindow(
  op: TmuxOpOf<'RenameWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const windowId = op.target ?? snapshot.activeWindowId;
  if (!windowId || isPlaceholderId(windowId)) return null;
  if (!snapshot.windows.some((w) => w.id === windowId)) return null;

  const patch: Patch = (s) => ({
    ...s,
    windows: s.windows.map((w) => (w.id === windowId ? { ...w, name: op.name } : w)),
  });
  return { patch, meta: { renamedWindowId: windowId, newName: op.name } };
}

export function reconcileRenameWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const windowId = meta.renamedWindowId as WindowId;
  const name = meta.newName as string;
  const window = windows.find((w) => w.id === windowId);
  if (!window) return { _tag: 'matched' };
  if (window.name === name) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

// ============================================
// MoveWindow (tab reorder)
// ============================================

/**
 * A dragged tab is already where the pointer left it when the drop commits,
 * so the strip must not jump back to the old order while `move-window`
 * travels: the windows are reordered here, keeping their index numbers in
 * strip order (`renumber-windows` is what tmux will do), and held until the
 * server's order agrees.
 */
export function predictMoveWindow(
  op: TmuxOpOf<'MoveWindow'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (isPlaceholderId(op.windowId) || isPlaceholderId(op.anchorId)) return null;
  if (op.windowId === op.anchorId) return null;
  const moving = snapshot.windows.find((w) => w.id === op.windowId);
  if (!moving || !snapshot.windows.some((w) => w.id === op.anchorId)) return null;

  const patch: Patch = (s) => {
    const rest = s.windows.filter((w) => w.id !== op.windowId);
    const anchorAt = rest.findIndex((w) => w.id === op.anchorId);
    if (anchorAt === -1) return s;
    const at = op.placement === 'before' ? anchorAt : anchorAt + 1;
    const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
    const indices = s.windows.map((w) => w.index).sort((a, b) => a - b);
    return { ...s, windows: ordered.map((w, i) => ({ ...w, index: indices[i] })) };
  };
  return {
    patch,
    meta: { movedWindowId: op.windowId, anchorId: op.anchorId, placement: op.placement },
  };
}

export function reconcileMoveWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const moved = windows.findIndex((w) => w.id === meta.movedWindowId);
  const anchor = windows.findIndex((w) => w.id === meta.anchorId);
  // Either window gone: there is no order left to wait for.
  if (moved === -1 || anchor === -1) return { _tag: 'matched' };
  const landed = meta.placement === 'before' ? moved + 1 === anchor : anchor + 1 === moved;
  return landed ? { _tag: 'matched' } : { _tag: 'pending' };
}

// ============================================
// GroupSwitch (pane-group tab switch)
// ============================================

/**
 * Predicts the visible-slot swap of a pane-group tab click: the clicked
 * (parked) member takes the previously-visible member's window and geometry;
 * the previously-visible member parks in the clicked member's old window.
 * Mirrors the guest pane-group-switch script (resize-window ; swap-pane).
 * Replaces the machine-level groupSwitchDimOverrides freeze + its 500/550/
 * 750ms timers (review follow-up #8: one owner per optimistic hold).
 */
export function predictGroupSwitch(
  op: TmuxOpOf<'GroupSwitch'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const clicked = snapshot.panes.find((p) => p.tmuxId === op.clickedPaneId);
  const visible = snapshot.panes.find((p) => p.tmuxId === op.visiblePaneId);
  if (!clicked || !visible || clicked.tmuxId === visible.tmuxId) return null;

  const clickedId = op.clickedPaneId;
  const visibleId = visible.tmuxId;
  const visibleSlot = {
    windowId: visible.windowId,
    x: visible.x,
    y: visible.y,
    width: visible.width,
    height: visible.height,
  };
  const parkedWindowId = clicked.windowId;

  // Self-neutralizes when either pane disappears mid-linger.
  const patch: Patch = (s) => {
    const hasClicked = s.panes.some((p) => p.tmuxId === clickedId);
    const hasVisible = s.panes.some((p) => p.tmuxId === visibleId);
    if (!hasClicked || !hasVisible) return s;
    return {
      ...s,
      panes: s.panes.map((p) => {
        if (p.tmuxId === clickedId) return { ...p, ...visibleSlot, active: true };
        if (p.tmuxId === visibleId) return { ...p, windowId: parkedWindowId, active: false };
        return p;
      }),
      activePaneId: clickedId,
    };
  };

  return {
    patch,
    meta: {
      clickedPaneId: clickedId,
      visiblePaneId: visibleId,
      visibleWindowId: visibleSlot.windowId,
    },
  };
}

export function reconcileGroupSwitch(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  serverActivePaneId: PaneId | null,
  ageMs: number,
): ReconcileVerdict {
  const clickedId = meta.clickedPaneId as PaneId;
  const visibleId = meta.visiblePaneId as PaneId;
  const clicked = panes.find((p) => p.tmuxId === clickedId);
  const visible = panes.find((p) => p.tmuxId === visibleId);
  if (!clicked || !visible) {
    // A pane involved in the swap is gone (killed mid-linger, group closed).
    // The patch self-neutralizes, so there's nothing left to pin — release
    // quietly rather than roll back and surface a phantom error.
    return { _tag: 'matched' };
  }
  // The member that was showing is the "previous" focus the swap moved from.
  return lingerVerdict(clickedId, visibleId, serverActivePaneId, ageMs);
}
