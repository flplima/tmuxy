import type { TmuxSnapshot, Patch, ReconcileVerdict } from './types';
import { FOCUS_CONFIRM_LINGER_MS, FOCUS_SUPERSEDE_GRACE_MS } from './types';
import type { TmuxPane } from '../client';
import type { TmuxOpOf } from '../commands';
import {
  isPlaceholderId,
  placeholderPaneId as newPlaceholderPaneId,
  type PaneId,
  type WindowId,
} from '../ids';
import type { PredictContext, PredictResult } from './ops';

// ============================================
// Split
// ============================================

export function predictSplit(
  op: TmuxOpOf<'Split'>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult | null {
  const activePaneId = snapshot.activePaneId;
  if (!activePaneId) return null;
  const activePane = snapshot.panes.find((p) => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const placeholderId = newPlaceholderPaneId(opId);
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

  const priorPaneIds: PaneId[] = snapshot.panes
    .filter((p) => !isPlaceholderId(p.tmuxId))
    .map((p) => p.tmuxId);

  return {
    patch,
    meta: { placeholderId, priorPaneIds },
  };
}

export function makePlaceholderPane(
  tmuxId: PaneId,
  windowId: WindowId,
  defaultShell: string,
  pos: { x: number; y: number; width: number; height: number },
): TmuxPane {
  return {
    id: -1,
    tmuxId,
    windowId,
    groupId: null,
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
    marked: false,
    paused: false,
    historySize: 0,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
    cursorShape: 0,
    cursorHidden: false,
  };
}

export function reconcileSplit(
  meta: Readonly<Record<string, unknown>>,
  committed: TmuxSnapshot,
  /** Real pane ids already claimed by earlier pending Split ops in this pass. */
  claimedRealIds: ReadonlySet<PaneId | WindowId>,
): ReconcileVerdict {
  const priorPaneIds = new Set(meta.priorPaneIds as PaneId[]);

  // The real new pane is any tmuxId in committed.panes that wasn't in priorPaneIds
  // and isn't a placeholder AND hasn't already been claimed by an earlier op
  // in the same reconcile pass.
  const realNew = committed.panes.find(
    (p) =>
      !priorPaneIds.has(p.tmuxId) && !isPlaceholderId(p.tmuxId) && !claimedRealIds.has(p.tmuxId),
  );
  if (!realNew) {
    return { _tag: 'pending' };
  }

  // The server is authoritative on final geometry — drift from our
  // half-and-half guess is expected (tmux's layout algorithm can land a cell
  // or two away) and does not affect matching.
  return { _tag: 'matched', realPaneId: realNew.tmuxId };
}

// ============================================
// Navigate / SelectPane (focus changes)
// ============================================

export function predictNavigate(
  op: TmuxOpOf<'Navigate'>,
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

export function predictSelectPane(
  op: TmuxOpOf<'SelectPane'>,
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
function focusPatch(targetId: PaneId): Patch {
  return (s) => (s.panes.some((p) => p.tmuxId === targetId) ? { ...s, activePaneId: targetId } : s);
}

export function reconcileFocus(
  meta: Readonly<Record<string, unknown>>,
  serverActivePaneId: PaneId | null,
  ageMs: number,
  committedPanes?: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const target = meta.targetPaneId as PaneId;
  const previous = meta.previousActivePaneId as PaneId | null | undefined;
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
  paneActivationOrder: ReadonlyArray<PaneId>,
): PaneId | null {
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

export function predictSwap(op: TmuxOpOf<'Swap'>, snapshot: TmuxSnapshot): PredictResult | null {
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

export function reconcileSwap(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const sourceId = meta.sourcePaneId as PaneId;
  const targetId = meta.targetPaneId as PaneId;
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
// KillPane
// ============================================

/**
 * The neighbor that absorbs a killed pane's freed space: a sibling sharing
 * the doomed pane's FULL edge (same cross-axis extent) — the common case for
 * split-created panes.
 */
function findAbsorber(doomed: TmuxPane, siblings: ReadonlyArray<TmuxPane>): TmuxPane | undefined {
  return siblings.find(
    (p) =>
      (p.x === doomed.x &&
        p.width === doomed.width &&
        (p.y + p.height + 1 === doomed.y || doomed.y + doomed.height + 1 === p.y)) ||
      (p.y === doomed.y &&
        p.height === doomed.height &&
        (p.x + p.width + 1 === doomed.x || doomed.x + doomed.width + 1 === p.x)),
  );
}

export function predictKillPane(
  op: TmuxOpOf<'KillPane'>,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
): PredictResult | null {
  const paneId = op.paneId ?? snapshot.activePaneId;
  if (!paneId || isPlaceholderId(paneId)) return null;
  const doomed = snapshot.panes.find((p) => p.tmuxId === paneId);
  if (!doomed) return null;

  const siblings = snapshot.panes.filter(
    (p) => p.windowId === doomed.windowId && p.tmuxId !== paneId,
  );

  // Focus falls to the most recently used surviving pane in the window.
  let nextFocus: PaneId | null = snapshot.activePaneId;
  if (snapshot.activePaneId === paneId) {
    nextFocus =
      ctx.paneActivationOrder.find(
        (id) => id !== paneId && siblings.some((p) => p.tmuxId === id),
      ) ??
      findAbsorber(doomed, siblings)?.tmuxId ??
      siblings[0]?.tmuxId ??
      null;
  }

  // Snapshot-relative and therefore idempotent: the absorber is located in
  // the snapshot being patched, not the dispatch-time one, so the patch
  // replays correctly over stale pre-kill echoes during the confirm linger
  // even when their row offsets differ (status-line shifts). Once the
  // server's post-kill layout is committed, the doomed pane is gone and the
  // geometry passes through untouched — re-expanding a confirmed layout
  // would double-add the space. tmux's layout tree can distribute the space
  // differently for hand-crafted layouts; the reconciler is lenient, so a
  // geometry drift self-corrects.
  const patch: Patch = (s) => {
    const doomedNow = s.panes.find((p) => p.tmuxId === paneId);
    if (!doomedNow) {
      return {
        ...s,
        activePaneId: s.activePaneId === paneId ? nextFocus : s.activePaneId,
      };
    }
    const sibs = s.panes.filter((p) => p.windowId === doomedNow.windowId && p.tmuxId !== paneId);
    const absorber = findAbsorber(doomedNow, sibs);
    const panes = s.panes
      .filter((p) => p.tmuxId !== paneId)
      .map((p) => {
        if (!absorber || p.tmuxId !== absorber.tmuxId) return p;
        return {
          ...p,
          x: Math.min(p.x, doomedNow.x),
          y: Math.min(p.y, doomedNow.y),
          width:
            p.y === doomedNow.y && p.height === doomedNow.height
              ? p.width + doomedNow.width + 1
              : p.width,
          height:
            p.x === doomedNow.x && p.width === doomedNow.width
              ? p.height + doomedNow.height + 1
              : p.height,
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

export function reconcileKillPane(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  ageMs: number,
): ReconcileVerdict {
  const killed = meta.killedPaneId as PaneId;
  if (!panes.some((p) => p.tmuxId === killed)) {
    // Confirmed — but linger: snapshots computed BEFORE the kill can still
    // arrive after the confirmation (the v86 capture pipeline routinely
    // delivers them 100s of ms late) and would resurrect the dead pane and
    // flap the absorber back to half-size the moment this op's patch is
    // gone. The patch is idempotent over confirmed layouts, so holding it
    // costs nothing.
    return ageMs >= FOCUS_CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
  }
  return { _tag: 'pending' };
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
export function predictZoomToggle(
  op: TmuxOpOf<'ZoomToggle'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const paneId = op.paneId ?? snapshot.activePaneId;
  if (!paneId || isPlaceholderId(paneId)) return null;
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

export function reconcileZoomToggle(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  ageMs: number,
): ReconcileVerdict {
  const paneId = meta.zoomedPaneId as PaneId | undefined;
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
