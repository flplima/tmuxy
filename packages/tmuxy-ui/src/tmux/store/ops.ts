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
): ReconcileVerdict {
  const { op, meta } = pending;
  switch (op._tag) {
    case 'Split':
      return reconcileSplit(meta, committed, claimed.panes);
    case 'Navigate':
      return reconcileFocus(meta, committed.activePaneId);
    case 'SelectPane':
      return reconcileFocus(meta, committed.activePaneId);
    case 'Swap':
      return reconcileSwap(meta, committed.panes);
    case 'NewWindow':
      return reconcileNewWindow(meta, committed.windows, claimed.windows);
    case 'SelectWindow':
      return reconcileSelectWindow(meta, committed.activeWindowId);
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
    meta: {
      placeholderId,
      priorPaneIds,
      // Used by reconciler to verify the resize landed close to prediction.
      expectedTarget: { paneId: activePaneId, ...resizedTarget },
      expectedNew: {
        x: newPane.x,
        y: newPane.y,
        width: newPane.width,
        height: newPane.height,
      },
    },
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

const SPLIT_POSITION_TOLERANCE = 1;

function reconcileSplit(
  meta: Readonly<Record<string, unknown>>,
  committed: TmuxSnapshot,
  /** Real pane ids already claimed by earlier pending Split ops in this pass. */
  claimedRealIds: ReadonlySet<string>,
): ReconcileVerdict {
  const priorPaneIds = new Set(meta.priorPaneIds as string[]);
  const expectedNew = meta.expectedNew as { x: number; y: number; width: number; height: number };

  // The real new pane is any tmuxId in committed.panes that wasn't in priorPaneIds
  // and isn't a placeholder AND hasn't already been claimed by an earlier op
  // in the same reconcile pass. Position-based matching is a sanity check —
  // tmux's layout algorithm can produce coordinates that differ from our
  // half-and-half prediction by a cell or two.
  const realNew = committed.panes.find(
    (p) =>
      !priorPaneIds.has(p.tmuxId) &&
      !p.tmuxId.startsWith('__placeholder_') &&
      !claimedRealIds.has(p.tmuxId),
  );
  if (!realNew) {
    return { _tag: 'pending' };
  }

  // If the real new pane lands far from the predicted position, log it but
  // still treat as matched — the server is authoritative, our prediction was
  // just a guess.
  const positionDrift =
    Math.abs(realNew.x - expectedNew.x) > SPLIT_POSITION_TOLERANCE ||
    Math.abs(realNew.y - expectedNew.y) > SPLIT_POSITION_TOLERANCE ||
    Math.abs(realNew.width - expectedNew.width) > SPLIT_POSITION_TOLERANCE ||
    Math.abs(realNew.height - expectedNew.height) > SPLIT_POSITION_TOLERANCE;
  if (positionDrift) {
    return {
      _tag: 'matched',
      realId: realNew.tmuxId,
    };
  }
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

  const patch: Patch = (s) => ({ ...s, activePaneId: targetId });
  return { patch, meta: { targetPaneId: targetId } };
}

function predictSelectPane(
  op: Extract<TmuxOp, { _tag: 'SelectPane' }>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  if (!snapshot.panes.some((p) => p.tmuxId === op.paneId)) return null;
  if (snapshot.activePaneId === op.paneId) return null;
  const patch: Patch = (s) => ({ ...s, activePaneId: op.paneId });
  return { patch, meta: { targetPaneId: op.paneId } };
}

function reconcileFocus(
  meta: Readonly<Record<string, unknown>>,
  serverActivePaneId: string | null,
): ReconcileVerdict {
  const target = meta.targetPaneId as string;
  if (serverActivePaneId === target) return { _tag: 'matched' };
  return { _tag: 'pending' };
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

  const patch: Patch = (s) => ({
    ...s,
    windows: [...s.windows.map((w) => ({ ...w, active: false })), placeholderWindow],
    panes: [...s.panes, placeholderPane],
    activeWindowId: placeholderWindowId,
    activePaneId: placeholderPaneId,
  });

  return {
    patch,
    meta: { placeholderWindowId, placeholderPaneId, priorWindowIds },
  };
}

function reconcileNewWindow(
  meta: Readonly<Record<string, unknown>>,
  windows: ReadonlyArray<TmuxWindow>,
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
      w.windowType === 'tab',
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

  const windowPanes = snapshot.panes.filter((p) => p.windowId === target!.id);
  const activeInTarget = windowPanes.find((p) => p.active) ?? windowPanes[0];
  if (!activeInTarget) return null;

  const targetId = target.id;
  const activePaneId = activeInTarget.tmuxId;
  const patch: Patch = (s) => ({ ...s, activeWindowId: targetId, activePaneId });

  return {
    patch,
    meta: { targetWindowId: targetId, targetActivePaneId: activePaneId },
  };
}

function reconcileSelectWindow(
  meta: Readonly<Record<string, unknown>>,
  serverActiveWindowId: string | null,
): ReconcileVerdict {
  const target = meta.targetWindowId as string;
  if (serverActiveWindowId === target) return { _tag: 'matched' };
  return { _tag: 'pending' };
}
