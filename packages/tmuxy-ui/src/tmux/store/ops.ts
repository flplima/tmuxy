/**
 * Per-op predict and reconcile logic.
 *
 * Every TmuxOp has up to three pure functions:
 *  - `predict(snapshot, ctx) → { patch, meta } | null` — what local change
 *    do we apply for instant UI feedback? null = no prediction possible
 *    (op falls through to fire-and-forget).
 *  - `reconcile(committed, derived, op) → ReconcileVerdict` — has the server
 *    caught up with our prediction? matched = drop the op; pending = keep
 *    waiting; failed = drop with warning.
 *  - `toTmuxCommand(op) → string` lives in parseCommand.ts.
 *
 * Keeping these pure (no side effects, no Refs) means every op can be tested
 * in isolation with no mocks. The store glues them together.
 */

import type { TmuxOp, TmuxSnapshot, Patch, ReconcileVerdict, PendingOp } from './types';
import { FOCUS_CONFIRM_LINGER_MS, FOCUS_SUPERSEDE_GRACE_MS } from './types';
import type { TmuxPane, TmuxWindow } from '../types';

// ============================================
// Dispatch-time context
// ============================================

/** Inputs the predictor needs beyond the snapshot itself. */
export interface PredictContext {
  readonly defaultShell: string;
  /** MRU pane order, used by Navigate to break overlap ties (mirrors tmux's
   *  window_pane_choose_best ranking by active_point). */
  readonly paneActivationOrder: ReadonlyArray<string>;
}

export interface PredictResult {
  readonly patch: Patch;
  readonly meta: Readonly<Record<string, unknown>>;
}

// ============================================
// Top-level dispatch
// ============================================

export function predict(
  op: TmuxOp,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult | null {
  switch (op._tag) {
    case 'Split':
      return predictSplit(op, snapshot, ctx, opId);
    case 'Navigate':
      return predictNavigate(op, snapshot, ctx);
    case 'SelectPane':
      return predictSelectPane(op, snapshot);
    case 'Swap':
      return predictSwap(op, snapshot);
    case 'NewWindow':
      return predictNewWindow(snapshot, ctx, opId);
    case 'SelectWindow':
      return predictSelectWindow(op, snapshot);
    case 'KillPane':
      return predictKillPane(op, snapshot, ctx);
    case 'KillWindow':
      return predictKillWindow(op, snapshot);
    case 'RenameWindow':
      return predictRenameWindow(op, snapshot);
    case 'ZoomToggle':
      return predictZoomToggle(op, snapshot);
    case 'GroupSwitch':
      return predictGroupSwitch(op, snapshot);
    case 'RawCommand':
      return null;
  }
}

export function reconcile(
  pending: PendingOp,
  committed: TmuxSnapshot,
  /**
   * Real pane / window ids already claimed by EARLIER pending ops in this
   * same reconcile pass. Critical when two Split ops are in flight at the
   * same time: without this set, both would match against the same real
   * pane id and the model would drop both ops prematurely. The reducer
   * threads this through `applyServerSnapshot`.
   */
  claimed: { panes: ReadonlySet<string>; windows: ReadonlySet<string> } = {
    panes: new Set(),
    windows: new Set(),
  },
  now: number = Date.now(),
): ReconcileVerdict {
  const { op, meta } = pending;
  switch (op._tag) {
    case 'Split':
      return reconcileSplit(meta, committed, claimed.panes);
    case 'Navigate':
      return reconcileFocus(meta, committed.activePaneId, now - pending.createdAt, committed.panes);
    case 'SelectPane':
      return reconcileFocus(meta, committed.activePaneId, now - pending.createdAt, committed.panes);
    case 'Swap':
      return reconcileSwap(meta, committed.panes);
    case 'NewWindow':
      return reconcileNewWindow(meta, committed.windows, committed.panes, claimed.windows);
    case 'SelectWindow':
      return reconcileSelectWindow(
        meta,
        committed.activeWindowId,
        now - pending.createdAt,
        committed.windows,
      );
    case 'KillPane':
      return reconcileKillPane(meta, committed.panes);
    case 'KillWindow':
      return reconcileKillWindow(meta, committed.windows);
    case 'RenameWindow':
      return reconcileRenameWindow(meta, committed.windows);
    case 'ZoomToggle':
      return reconcileZoomToggle(meta, committed.panes, now - pending.createdAt);
    case 'GroupSwitch':
      return reconcileGroupSwitch(
        meta,
        committed.panes,
        committed.activePaneId,
        now - pending.createdAt,
      );
    case 'RawCommand':
      // Raw commands have no prediction, so there's nothing to wait for.
      return { _tag: 'matched' };
  }
}

// ============================================
// Split
// ============================================

function predictSplit(
  op: Extract<TmuxOp, { _tag: 'Split' }>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult | null {
  const activePaneId = snapshot.activePaneId;
  if (!activePaneId) return null;
  const activePane = snapshot.panes.find((p) => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const placeholderId = `__placeholder_${opId}`;
  const windowId = snapshot.activeWindowId ?? activePane.windowId;

  let newPane: TmuxPane;
  let resizedTarget: Pick<TmuxPane, 'x' | 'y' | 'width' | 'height'>;

  if (op.direction === 'vertical') {
    // -h: side-by-side, new pane to the right of the active one
    const newWidth = Math.floor(activePane.width / 2);
    const originalNewWidth = activePane.width - newWidth - 1;
    resizedTarget = {
      x: activePane.x,
      y: activePane.y,
      width: originalNewWidth,
      height: activePane.height,
    };
    newPane = makePlaceholderPane(placeholderId, windowId, ctx.defaultShell, {
      x: activePane.x + originalNewWidth + 1,
      y: activePane.y,
      width: newWidth,
      height: activePane.height,
    });
  } else {
    // -v: stacked, new pane below
    const newHeight = Math.floor(activePane.height / 2);
    const originalNewHeight = activePane.height - newHeight - 1;
    resizedTarget = {
      x: activePane.x,
      y: activePane.y,
      width: activePane.width,
      height: originalNewHeight,
    };
    newPane = makePlaceholderPane(placeholderId, windowId, ctx.defaultShell, {
      x: activePane.x,
      y: activePane.y + originalNewHeight + 1,
      width: activePane.width,
      height: newHeight,
    });
  }

  const patch: Patch = (s) => {
    const panes = s.panes.map((p) => {
      if (p.windowId !== windowId) return p;
      if (p.tmuxId === activePaneId) return { ...p, ...resizedTarget };
      return p;
    });
    return {
      ...s,
      panes: [...panes, newPane],
      activePaneId: placeholderId,
    };
  };

  const priorPaneIds: string[] = snapshot.panes
    .filter((p) => !p.tmuxId.startsWith('__placeholder_'))
    .map((p) => p.tmuxId);

  return {
    patch,
    meta: { placeholderId, priorPaneIds },
  };
}

function makePlaceholderPane(
  tmuxId: string,
  windowId: string,
  defaultShell: string,
  pos: { x: number; y: number; width: number; height: number },
): TmuxPane {
  return {
    id: -1,
    tmuxId,
    windowId,
    content: [],
    cursorX: 0,
    cursorY: 0,
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    active: true,
    command: defaultShell,
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

function reconcileSplit(
  meta: Readonly<Record<string, unknown>>,
  committed: TmuxSnapshot,
  /** Real pane ids already claimed by earlier pending Split ops in this pass. */
  claimedRealIds: ReadonlySet<string>,
): ReconcileVerdict {
  const priorPaneIds = new Set(meta.priorPaneIds as string[]);

  // The real new pane is any tmuxId in committed.panes that wasn't in priorPaneIds
  // and isn't a placeholder AND hasn't already been claimed by an earlier op
  // in the same reconcile pass.
  const realNew = committed.panes.find(
    (p) =>
      !priorPaneIds.has(p.tmuxId) &&
      !p.tmuxId.startsWith('__placeholder_') &&
      !claimedRealIds.has(p.tmuxId),
  );
  if (!realNew) {
    return { _tag: 'pending' };
  }

  // The server is authoritative on final geometry — drift from our
  // half-and-half guess is expected (tmux's layout algorithm can land a cell
  // or two away) and does not affect matching.
  return { _tag: 'matched', realId: realNew.tmuxId };
}

// ============================================
// Navigate / SelectPane (focus changes)
// ============================================

function predictNavigate(
  op: Extract<TmuxOp, { _tag: 'Navigate' }>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
): PredictResult | null {
  const activePaneId = snapshot.activePaneId;
  if (!activePaneId) return null;
  const activePane = snapshot.panes.find((p) => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const targetId = findAdjacentPane(
    snapshot.panes,
    activePane,
    op.direction,
    ctx.paneActivationOrder,
  );
  if (!targetId) return null;

  const patch = focusPatch(targetId);
  return { patch, meta: { targetPaneId: targetId, previousActivePaneId: activePaneId } };
}

function predictSelectPane(
  op: Extract<TmuxOp, { _tag: 'SelectPane' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (!snapshot.panes.some((p) => p.tmuxId === op.paneId)) return null;
  if (snapshot.activePaneId === op.paneId) return null;
  const patch = focusPatch(op.paneId);
  return {
    patch,
    meta: { targetPaneId: op.paneId, previousActivePaneId: snapshot.activePaneId },
  };
}

/**
 * Focus pin that self-neutralizes when its target no longer exists: a later
 * op in the chain (KillPane) or a server update may remove the pane, and a
 * lingering focus op must never pin the UI to a dead id.
 */
function focusPatch(targetId: string): Patch {
  return (s) => (s.panes.some((p) => p.tmuxId === targetId) ? { ...s, activePaneId: targetId } : s);
}

function reconcileFocus(
  meta: Readonly<Record<string, unknown>>,
  serverActivePaneId: string | null,
  ageMs: number,
  committedPanes?: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const target = meta.targetPaneId as string;
  const previous = meta.previousActivePaneId as string | null | undefined;
  if (committedPanes && !committedPanes.some((p) => p.tmuxId === target)) {
    // The target pane is gone — nothing left to pin.
    return { _tag: 'matched' };
  }
  if (serverActivePaneId === target) {
    // Confirmed — but linger: snapshots computed BEFORE the focus change can
    // still arrive after the confirmation and would flap the highlight the
    // moment this op's pin is gone. See FOCUS_CONFIRM_LINGER_MS.
    return ageMs >= FOCUS_CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
  }
  if (serverActivePaneId === previous && ageMs < FOCUS_CONFIRM_LINGER_MS) {
    // A stale echo of the pre-op focus — hold the pin.
    return { _tag: 'pending' };
  }
  if (ageMs < FOCUS_SUPERSEDE_GRACE_MS) {
    // Very young: the server may simply not have processed us yet.
    return { _tag: 'pending' };
  }
  // Focus moved somewhere else after we were processed — the server wins;
  // holding the pin would freeze the UI on a focus tmux no longer has.
  return { _tag: 'matched' };
}

/**
 * Find the pane adjacent to `current` in `direction` (matches tmux's
 * window_pane_find_* algorithm: adjacent edge + axis overlap + MRU tiebreak).
 */
function findAdjacentPane(
  panes: ReadonlyArray<TmuxPane>,
  current: TmuxPane,
  direction: 'L' | 'R' | 'U' | 'D',
  paneActivationOrder: ReadonlyArray<string>,
): string | null {
  const candidates: TmuxPane[] = [];

  for (const pane of panes) {
    if (pane.tmuxId === current.tmuxId) continue;
    if (pane.windowId !== current.windowId) continue;

    let isAdjacent = false;
    let hasOverlap = false;

    switch (direction) {
      case 'L':
        isAdjacent = pane.x + pane.width + 1 === current.x;
        if (isAdjacent)
          hasOverlap = axisOverlap(
            current.y,
            current.y + current.height,
            pane.y,
            pane.y + pane.height - 1,
          );
        break;
      case 'R':
        isAdjacent = current.x + current.width + 1 === pane.x;
        if (isAdjacent)
          hasOverlap = axisOverlap(
            current.y,
            current.y + current.height,
            pane.y,
            pane.y + pane.height - 1,
          );
        break;
      case 'U':
        isAdjacent = pane.y + pane.height + 1 === current.y;
        if (isAdjacent)
          hasOverlap = axisOverlap(
            current.x,
            current.x + current.width,
            pane.x,
            pane.x + pane.width - 1,
          );
        break;
      case 'D':
        isAdjacent = current.y + current.height + 1 === pane.y;
        if (isAdjacent)
          hasOverlap = axisOverlap(
            current.x,
            current.x + current.width,
            pane.x,
            pane.x + pane.width - 1,
          );
        break;
    }

    if (isAdjacent && hasOverlap) candidates.push(pane);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].tmuxId;
  for (const paneId of paneActivationOrder) {
    const match = candidates.find((p) => p.tmuxId === paneId);
    if (match) return match.tmuxId;
  }
  return candidates[0].tmuxId;
}

function axisOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return (
    (bStart < aStart && bEnd > aEnd) ||
    (bStart >= aStart && bStart <= aEnd) ||
    (bEnd >= aStart && bEnd <= aEnd)
  );
}

// ============================================
// Swap
// ============================================

function predictSwap(
  op: Extract<TmuxOp, { _tag: 'Swap' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const sourcePane = snapshot.panes.find((p) => p.tmuxId === op.sourcePaneId);
  const targetPane = snapshot.panes.find((p) => p.tmuxId === op.targetPaneId);
  if (!sourcePane || !targetPane) return null;

  const sourcePos = {
    x: targetPane.x,
    y: targetPane.y,
    width: targetPane.width,
    height: targetPane.height,
  };
  const targetPos = {
    x: sourcePane.x,
    y: sourcePane.y,
    width: sourcePane.width,
    height: sourcePane.height,
  };

  const patch: Patch = (s) => ({
    ...s,
    panes: s.panes.map((p) => {
      if (p.tmuxId === op.sourcePaneId) return { ...p, ...sourcePos };
      if (p.tmuxId === op.targetPaneId) return { ...p, ...targetPos };
      return p;
    }),
  });

  return {
    patch,
    meta: {
      sourcePaneId: op.sourcePaneId,
      targetPaneId: op.targetPaneId,
      expectedSourcePos: sourcePos,
      expectedTargetPos: targetPos,
    },
  };
}

const SWAP_POSITION_TOLERANCE = 1;

function reconcileSwap(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const sourceId = meta.sourcePaneId as string;
  const targetId = meta.targetPaneId as string;
  const expectedSource = meta.expectedSourcePos as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const expectedTarget = meta.expectedTargetPos as {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  const sourcePane = panes.find((p) => p.tmuxId === sourceId);
  const targetPane = panes.find((p) => p.tmuxId === targetId);
  if (!sourcePane || !targetPane) {
    return { _tag: 'failed', reason: `Swap: pane disappeared (${sourceId} / ${targetId})` };
  }

  const sourceOk = positionClose(sourcePane, expectedSource);
  const targetOk = positionClose(targetPane, expectedTarget);
  if (sourceOk && targetOk) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

function positionClose(
  pane: TmuxPane,
  expected: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(pane.x - expected.x) <= SWAP_POSITION_TOLERANCE &&
    Math.abs(pane.y - expected.y) <= SWAP_POSITION_TOLERANCE &&
    Math.abs(pane.width - expected.width) <= SWAP_POSITION_TOLERANCE &&
    Math.abs(pane.height - expected.height) <= SWAP_POSITION_TOLERANCE
  );
}

// ============================================
// NewWindow
// ============================================

function predictNewWindow(
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult {
  const maxIndex = snapshot.windows.reduce((m, w) => Math.max(m, w.index), -1);
  const placeholderWindowId = `__placeholder_${opId}`;
  const placeholderPaneId = `__placeholder_pane_${opId}`;
  const placeholderWindow: TmuxWindow = {
    id: placeholderWindowId,
    index: maxIndex + 1,
    name: `Window ${maxIndex + 1}`,
    active: true,
    windowType: 'tab',
    groupPanes: null,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
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
          (w) =>
            !priorWindowIds.includes(w.id) &&
            !w.id.startsWith('__placeholder_') &&
            !isRenderableTab(w),
        )
        .map((w) => w.id),
    );
    const knownWindowIds = new Set(s.windows.map((w) => w.id));
    const isNewbornPane = (p: TmuxPane): boolean => {
      if (priorWindowIds.includes(p.windowId)) return false;
      if (p.windowId === placeholderWindowId || p.windowId.startsWith('__placeholder_'))
        return false;
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

function reconcileNewWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
  panes: ReadonlyArray<TmuxPane>,
  /** Real window ids already claimed by earlier pending NewWindow ops. */
  claimedRealIds: ReadonlySet<string>,
): ReconcileVerdict {
  const prior = new Set(meta.priorWindowIds as string[]);
  if (windows.length === 0) return { _tag: 'pending' };
  const candidate = windows.find(
    (w) =>
      !prior.has(w.id) &&
      !w.id.startsWith('__placeholder_') &&
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
  if (candidate) return { _tag: 'matched', realId: candidate.id };
  return { _tag: 'pending' };
}

// ============================================
// SelectWindow (tab switch)
// ============================================

function predictSelectWindow(
  op: Extract<TmuxOp, { _tag: 'SelectWindow' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (!snapshot.activeWindowId) return null;
  const visible = snapshot.windows.filter((w) => w.windowType === 'tab');
  if (visible.length === 0) return null;

  let target: TmuxWindow | undefined;
  if (typeof op.target === 'number') {
    target = visible.find((w) => w.index === op.target);
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
    const activeInTarget = targetPanes.find((p) => p.active) ?? targetPanes[0];
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
function reconcileSelectWindow(
  meta: Readonly<Record<string, unknown>>,
  serverActiveWindowId: string | null,
  ageMs: number,
  committedWindows?: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const target = meta.targetWindowId as string;
  const previous = meta.previousActiveWindowId as string | null | undefined;
  if (committedWindows && !committedWindows.some((w) => w.id === target)) {
    // The target window is gone — nothing left to pin.
    return { _tag: 'matched' };
  }
  if (serverActiveWindowId === target) {
    return ageMs >= FOCUS_CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
  }
  if (serverActiveWindowId === previous && ageMs < FOCUS_CONFIRM_LINGER_MS) {
    return { _tag: 'pending' };
  }
  if (ageMs < FOCUS_SUPERSEDE_GRACE_MS) {
    return { _tag: 'pending' };
  }
  return { _tag: 'matched' };
}

// ============================================
// KillPane
// ============================================

function predictKillPane(
  op: Extract<TmuxOp, { _tag: 'KillPane' }>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
): PredictResult | null {
  const paneId = op.paneId ?? snapshot.activePaneId;
  if (!paneId || paneId.startsWith('__placeholder_')) return null;
  const doomed = snapshot.panes.find((p) => p.tmuxId === paneId);
  if (!doomed) return null;

  // The neighbor that absorbs the freed space: a pane sharing the doomed
  // pane's FULL edge (same cross-axis extent) — the common case for panes
  // created by splits. tmux's layout tree can distribute the space
  // differently for hand-crafted layouts; the reconciler is lenient (it only
  // waits for the pane to disappear), so a geometry drift self-corrects.
  const siblings = snapshot.panes.filter(
    (p) => p.windowId === doomed.windowId && p.tmuxId !== paneId,
  );
  const absorber = siblings.find(
    (p) =>
      (p.x === doomed.x &&
        p.width === doomed.width &&
        (p.y + p.height + 1 === doomed.y || doomed.y + doomed.height + 1 === p.y)) ||
      (p.y === doomed.y &&
        p.height === doomed.height &&
        (p.x + p.width + 1 === doomed.x || doomed.x + doomed.width + 1 === p.x)),
  );

  // Focus falls to the most recently used surviving pane in the window.
  let nextFocus: string | null = snapshot.activePaneId;
  if (snapshot.activePaneId === paneId) {
    nextFocus =
      ctx.paneActivationOrder.find(
        (id) => id !== paneId && siblings.some((p) => p.tmuxId === id),
      ) ??
      absorber?.tmuxId ??
      siblings[0]?.tmuxId ??
      null;
  }

  const patch: Patch = (s) => {
    const panes = s.panes
      .filter((p) => p.tmuxId !== paneId)
      .map((p) => {
        if (!absorber || p.tmuxId !== absorber.tmuxId) return p;
        return {
          ...p,
          x: Math.min(p.x, doomed.x),
          y: Math.min(p.y, doomed.y),
          width:
            p.y === doomed.y && p.height === doomed.height ? p.width + doomed.width + 1 : p.width,
          height:
            p.x === doomed.x && p.width === doomed.width ? p.height + doomed.height + 1 : p.height,
        };
      });
    return {
      ...s,
      panes,
      activePaneId: s.activePaneId === paneId ? nextFocus : s.activePaneId,
    };
  };

  return { patch, meta: { killedPaneId: paneId } };
}

function reconcileKillPane(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const killed = meta.killedPaneId as string;
  if (!panes.some((p) => p.tmuxId === killed)) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

// ============================================
// KillWindow
// ============================================

function predictKillWindow(
  op: Extract<TmuxOp, { _tag: 'KillWindow' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const windowId = op.windowId ?? snapshot.activeWindowId;
  if (!windowId || windowId.startsWith('__placeholder_')) return null;
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

function reconcileKillWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const killed = meta.killedWindowId as string;
  if (!windows.some((w) => w.id === killed)) return { _tag: 'matched' };
  return { _tag: 'pending' };
}

// ============================================
// RenameWindow
// ============================================

function predictRenameWindow(
  op: Extract<TmuxOp, { _tag: 'RenameWindow' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const windowId = op.target ?? snapshot.activeWindowId;
  if (!windowId || windowId.startsWith('__placeholder_')) return null;
  if (!snapshot.windows.some((w) => w.id === windowId)) return null;

  const patch: Patch = (s) => ({
    ...s,
    windows: s.windows.map((w) => (w.id === windowId ? { ...w, name: op.name } : w)),
  });
  return { patch, meta: { renamedWindowId: windowId, newName: op.name } };
}

function reconcileRenameWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
): ReconcileVerdict {
  const windowId = meta.renamedWindowId as string;
  const name = meta.newName as string;
  const window = windows.find((w) => w.id === windowId);
  if (!window) return { _tag: 'matched' };
  if (window.name === name) return { _tag: 'matched' };
  return { _tag: 'pending' };
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
function predictGroupSwitch(
  op: Extract<TmuxOp, { _tag: 'GroupSwitch' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const clicked = snapshot.panes.find((p) => p.tmuxId === op.clickedPaneId);
  const visible = snapshot.panes.find((p) => p.tmuxId === op.visiblePaneId);
  if (!clicked || !visible || clicked.tmuxId === visible.tmuxId) return null;

  const clickedId = op.clickedPaneId;
  const visibleId = op.visiblePaneId;
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

function reconcileGroupSwitch(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  serverActivePaneId: string | null,
  ageMs: number,
): ReconcileVerdict {
  const clickedId = meta.clickedPaneId as string;
  const visibleId = meta.visiblePaneId as string;
  const clicked = panes.find((p) => p.tmuxId === clickedId);
  const visible = panes.find((p) => p.tmuxId === visibleId);
  if (!clicked || !visible) {
    // A pane involved in the swap is gone (killed mid-linger, group closed).
    // The patch self-neutralizes, so there's nothing left to pin — release
    // quietly rather than roll back and surface a phantom error.
    return { _tag: 'matched' };
  }
  if (serverActivePaneId === clickedId) {
    // Confirmed — but linger: snapshots computed BEFORE the swap can still
    // arrive after the confirmation and would flap the group back the moment
    // this op's pin is gone (same shape as reconcileFocus).
    return ageMs >= FOCUS_CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
  }
  if (serverActivePaneId === visibleId && ageMs < FOCUS_CONFIRM_LINGER_MS) {
    // A stale echo of the pre-swap focus — hold the pin.
    return { _tag: 'pending' };
  }
  if (ageMs < FOCUS_SUPERSEDE_GRACE_MS) {
    // Very young: the guest script's swap-pane may not have landed yet.
    return { _tag: 'pending' };
  }
  // Focus moved to a THIRD pane after we were processed (e.g. a new group
  // member was added and became active) — the server wins. Holding the pin
  // would freeze activePaneId on a focus tmux no longer has, masking every
  // later focus change for the rest of the linger.
  return { _tag: 'matched' };
}

// ============================================
// ZoomToggle
// ============================================

const ZOOM_SIZE_TOLERANCE = 2;

/**
 * Predicts zoom-IN only: the pane's geometry expands to the window extent —
 * exactly what the server does (%layout-change's visible_layout rewrites only
 * the zoomed pane; siblings keep their pre-zoom rects). Zoom-OUT is not
 * predicted: the pane's pre-zoom slot was overwritten by the zoom and is
 * unknown client-side, so unzoom waits for the server layout.
 */
function predictZoomToggle(
  op: Extract<TmuxOp, { _tag: 'ZoomToggle' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const paneId = op.paneId ?? snapshot.activePaneId;
  if (!paneId || paneId.startsWith('__placeholder_')) return null;
  const pane = snapshot.panes.find((p) => p.tmuxId === paneId);
  if (!pane) return null;

  const windowPanes = snapshot.panes.filter((p) => p.windowId === pane.windowId);
  if (windowPanes.length < 2) return null;
  const extentW = Math.max(...windowPanes.map((p) => p.x + p.width));
  const extentH = Math.max(...windowPanes.map((p) => p.y + p.height));

  // Already ~full-extent → this toggle is an unzoom → no prediction.
  if (pane.width >= extentW - 1 && pane.height >= extentH - 1) return null;

  const patch: Patch = (s) => ({
    ...s,
    panes: s.panes.map((p) =>
      p.tmuxId === paneId ? { ...p, x: 0, y: 0, width: extentW, height: extentH } : p,
    ),
  });
  return {
    patch,
    meta: {
      zoomedPaneId: paneId,
      extentW,
      extentH,
      before: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
    },
  };
}

function reconcileZoomToggle(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  ageMs: number,
): ReconcileVerdict {
  const paneId = meta.zoomedPaneId as string | undefined;
  // Unzoom toggles carry no prediction (empty meta) — nothing to wait for.
  if (!paneId) return { _tag: 'matched' };
  const extentW = meta.extentW as number;
  const extentH = meta.extentH as number;
  const before = meta.before as { x: number; y: number; width: number; height: number };
  const pane = panes.find((p) => p.tmuxId === paneId);
  if (!pane) return { _tag: 'failed', reason: `ZoomToggle: pane ${paneId} disappeared` };
  if (pane.width >= extentW - ZOOM_SIZE_TOLERANCE && pane.height >= extentH - ZOOM_SIZE_TOLERANCE) {
    return { _tag: 'matched' };
  }
  // The pane is back at (or still at) its pre-zoom rect past the processing
  // grace: the toggle was undone (rapid zoom+unzoom) or never landed — drop
  // the patch, or the pinned zoomed geometry wedges the UI on an idle stream.
  if (
    ageMs >= FOCUS_SUPERSEDE_GRACE_MS &&
    Math.abs(pane.width - before.width) <= ZOOM_SIZE_TOLERANCE &&
    Math.abs(pane.height - before.height) <= ZOOM_SIZE_TOLERANCE
  ) {
    return { _tag: 'matched' };
  }
  return { _tag: 'pending' };
}
