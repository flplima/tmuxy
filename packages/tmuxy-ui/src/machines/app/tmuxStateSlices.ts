/**
 * Per-state slices of TMUX_STATE_UPDATE reconciliation.
 *
 * The parent's TMUX_STATE_UPDATE handler in appMachine.ts is the central
 * reconcile point — it currently runs ~600 lines in a single enqueueActions
 * block. Phase D′ task #8 splits its work into per-state pure functions
 * here. Each slice:
 *
 *   - Takes (currentContext, transformedServerState) and returns a partial
 *     update covering only the fields its state owns (per FIELD_OWNERS).
 *   - Has no side effects — no sendTo, no setTimeout, just pure context math.
 *     Side-effecting concerns (animation triggers, keyboard actor updates,
 *     timers) stay in the parent handler that calls these slices.
 *   - Is testable in isolation with no XState plumbing.
 *
 * STATUS: this is the slice toolkit. The parent's TMUX_STATE_UPDATE handler
 * has NOT yet been refactored to call them — it still inlines the logic.
 * The slices are the destination; migration of each callsite into a slice
 * call is incremental. Until that's done, the slice + the inline handler
 * are kept in lock-step by the unit tests below.
 */

import type { AppMachineContext } from '../types';
import type { CopyModeState } from '../../tmux/types';

/**
 * The shape we get out of transformServerState() in helpers.ts. We accept
 * a minimal subset here so the slices remain decoupled from the full
 * ServerState type.
 */
export interface TransformedState {
  readonly panes: AppMachineContext['panes'];
  readonly windows: AppMachineContext['windows'];
  readonly activeWindowId: string | null;
  readonly activePaneId: string | null;
  readonly statusLine?: string;
  readonly totalWidth?: number;
  readonly totalHeight?: number;
}

// ============================================
// copyMode slice
// ============================================

/**
 * Drop CopyModeState entries for panes that:
 *   - no longer exist in the server snapshot, OR
 *   - tmux now reports as NOT in copy mode (server exited copy mode for us).
 *
 * Returns the new copyModeStates record. If no changes, returns the input
 * by reference so a downstream `if (next !== prev) assign(...)` shortcut
 * keeps the React tree stable.
 */
export function sliceCopyModeStates(
  current: Record<string, CopyModeState>,
  next: TransformedState,
): Record<string, CopyModeState> {
  const liveIds = new Set(next.panes.map((p) => p.tmuxId));
  const panesById = new Map(next.panes.map((p) => [p.tmuxId, p]));

  let changed = false;
  const result: Record<string, CopyModeState> = {};
  for (const [paneId, state] of Object.entries(current)) {
    if (!liveIds.has(paneId)) {
      changed = true;
      continue; // pane gone → drop
    }
    const pane = panesById.get(paneId);
    if (pane && !pane.inMode) {
      changed = true;
      continue; // server says copy mode is off → drop
    }
    result[paneId] = state;
  }
  return changed ? result : current;
}

// ============================================
// commandUi slice
// ============================================

/**
 * statusLine is pushed by tmux through state updates. The slice is trivial
 * (just propagate the value if it changed), but giving it a named home
 * makes the field-ownership audit complete.
 */
export function sliceStatusLine(current: string, next: TransformedState): string | undefined {
  if (next.statusLine === undefined || next.statusLine === current) return undefined;
  return next.statusLine;
}

// ============================================
// layout slices
// ============================================

/**
 * Pane MRU tracking: when activePaneId changes between updates, prepend
 * the new active pane to paneActivationOrder (keeping most-recently-active
 * first). Prunes panes that no longer exist.
 */
export function sliceActivationOrder(
  currentOrder: readonly string[],
  newActivePaneId: string | null,
  livePanes: readonly { tmuxId: string }[],
): string[] | undefined {
  const liveIds = new Set(livePanes.map((p) => p.tmuxId));
  // Drop dead panes from the order (left as-is if none changed).
  const pruned = currentOrder.filter((id) => liveIds.has(id));

  if (!newActivePaneId || !liveIds.has(newActivePaneId)) {
    // No new active pane — only return a pruned list if something was removed.
    return pruned.length === currentOrder.length ? undefined : pruned;
  }

  if (pruned[0] === newActivePaneId) {
    // Already at the front — no change unless pruning changed anything.
    return pruned.length === currentOrder.length ? undefined : pruned;
  }

  return [newActivePaneId, ...pruned.filter((id) => id !== newActivePaneId)];
}

/**
 * lastActivePaneByWindow tracking: for each window represented in the new
 * panes list, remember the currently-active pane so SELECT_TAB can restore
 * focus to where the user left it.
 */
export function sliceLastActivePaneByWindow(
  current: Record<string, string>,
  next: TransformedState,
): Record<string, string> | undefined {
  let changed = false;
  const result: Record<string, string> = { ...current };

  // For each window that has an active pane in the new snapshot, record it.
  const activeByWindow = new Map<string, string>();
  for (const pane of next.panes) {
    if (pane.active) {
      activeByWindow.set(pane.windowId, pane.tmuxId);
    }
  }
  for (const [windowId, paneId] of activeByWindow) {
    if (result[windowId] !== paneId) {
      result[windowId] = paneId;
      changed = true;
    }
  }

  // Prune windows that no longer exist.
  const liveWindowIds = new Set(next.windows.map((w) => w.id));
  for (const windowId of Object.keys(result)) {
    if (!liveWindowIds.has(windowId)) {
      delete result[windowId];
      changed = true;
    }
  }

  return changed ? result : undefined;
}

/**
 * Detect panes that vanished between snapshots, EXCLUDING optimistic
 * placeholders (which the layout state owns the lifecycle of and which
 * should be silently replaced, not animated out).
 */
export function detectRemovedPanes(
  oldPanes: readonly { tmuxId: string }[],
  newPanes: readonly { tmuxId: string }[],
): string[] {
  const newIds = new Set(newPanes.map((p) => p.tmuxId));
  return oldPanes
    .filter((p) => !newIds.has(p.tmuxId) && !p.tmuxId.startsWith('__placeholder_'))
    .map((p) => p.tmuxId);
}
