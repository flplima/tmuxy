/**
 * Reconciliation Module
 *
 * Compares optimistic predictions against server state.
 * Determines if predictions matched and handles rollback logging.
 */

import type { TmuxPane } from '../../../tmux/types';
import type {
  OptimisticOperation,
  SplitPrediction,
  NavigatePrediction,
  SwapPrediction,
} from '../../types';

/** Position tolerance for comparing pane positions (in cells) */
const POSITION_TOLERANCE = 1;

export interface ReconciliationResult {
  /** Whether the prediction matched server state (within tolerance) */
  matched: boolean;
  /** Description of what didn't match (for logging) */
  mismatchReason?: string;
}

/**
 * Reconcile an optimistic prediction with actual server state.
 *
 * Always returns the server state as the final truth, but logs
 * warnings if predictions were wrong (useful for debugging).
 */
export function reconcileOptimisticUpdate(
  operation: OptimisticOperation,
  serverPanes: TmuxPane[],
  serverActivePaneId: string | null,
): ReconciliationResult {
  const { prediction } = operation;

  switch (prediction.type) {
    case 'split':
      return reconcileSplit(prediction, serverPanes);
    case 'navigate':
      return reconcileNavigate(prediction, serverActivePaneId);
    case 'swap':
      return reconcileSwap(prediction, serverPanes);
    default:
      return { matched: true };
  }
}

/**
 * Reconcile split prediction.
 * Check if a new pane appeared in approximately the expected position.
 */
function reconcileSplit(
  prediction: SplitPrediction,
  serverPanes: TmuxPane[],
): ReconciliationResult {
  const { newPane, resizedPanes } = prediction;

  // Find a pane in approximately the expected position for the new pane
  const foundNewPane = serverPanes.find(
    (pane) =>
      isPositionClose(pane.x, newPane.x) &&
      isPositionClose(pane.y, newPane.y) &&
      isPositionClose(pane.width, newPane.width) &&
      isPositionClose(pane.height, newPane.height),
  );

  if (!foundNewPane) {
    return {
      matched: false,
      mismatchReason: `Split prediction: expected new pane at (${newPane.x}, ${newPane.y}) with size ${newPane.width}x${newPane.height}, but no matching pane found`,
    };
  }

  // Check if the resized panes have approximately correct dimensions
  for (const resized of resizedPanes) {
    const serverPane = serverPanes.find((p) => p.tmuxId === resized.paneId);
    if (!serverPane) continue;

    if (
      !isPositionClose(serverPane.x, resized.x) ||
      !isPositionClose(serverPane.y, resized.y) ||
      !isPositionClose(serverPane.width, resized.width) ||
      !isPositionClose(serverPane.height, resized.height)
    ) {
      return {
        matched: false,
        mismatchReason: `Split prediction: pane ${resized.paneId} expected at (${resized.x}, ${resized.y}) ${resized.width}x${resized.height}, but found at (${serverPane.x}, ${serverPane.y}) ${serverPane.width}x${serverPane.height}`,
      };
    }
  }

  return { matched: true };
}

/**
 * Reconcile navigation prediction.
 * Check if the active pane matches the predicted target.
 */
function reconcileNavigate(
  prediction: NavigatePrediction,
  serverActivePaneId: string | null,
): ReconciliationResult {
  if (serverActivePaneId === prediction.toPaneId) {
    return { matched: true };
  }

  return {
    matched: false,
    mismatchReason: `Navigate prediction: expected active pane ${prediction.toPaneId}, but server has ${serverActivePaneId}`,
  };
}

/**
 * Reconcile swap prediction.
 * Check if both panes are in their expected new positions.
 */
function reconcileSwap(prediction: SwapPrediction, serverPanes: TmuxPane[]): ReconciliationResult {
  const sourcePane = serverPanes.find((p) => p.tmuxId === prediction.sourcePaneId);
  const targetPane = serverPanes.find((p) => p.tmuxId === prediction.targetPaneId);

  if (!sourcePane || !targetPane) {
    return {
      matched: false,
      mismatchReason: `Swap prediction: one or both panes not found (source: ${prediction.sourcePaneId}, target: ${prediction.targetPaneId})`,
    };
  }

  const sourceMatches =
    isPositionClose(sourcePane.x, prediction.sourceNewPosition.x) &&
    isPositionClose(sourcePane.y, prediction.sourceNewPosition.y) &&
    isPositionClose(sourcePane.width, prediction.sourceNewPosition.width) &&
    isPositionClose(sourcePane.height, prediction.sourceNewPosition.height);

  const targetMatches =
    isPositionClose(targetPane.x, prediction.targetNewPosition.x) &&
    isPositionClose(targetPane.y, prediction.targetNewPosition.y) &&
    isPositionClose(targetPane.width, prediction.targetNewPosition.width) &&
    isPositionClose(targetPane.height, prediction.targetNewPosition.height);

  if (!sourceMatches || !targetMatches) {
    return {
      matched: false,
      mismatchReason: `Swap prediction: position mismatch. Source ${prediction.sourcePaneId} expected (${prediction.sourceNewPosition.x}, ${prediction.sourceNewPosition.y}), got (${sourcePane.x}, ${sourcePane.y}). Target ${prediction.targetPaneId} expected (${prediction.targetNewPosition.x}, ${prediction.targetNewPosition.y}), got (${targetPane.x}, ${targetPane.y})`,
    };
  }

  return { matched: true };
}

/**
 * Check if two positions are within tolerance.
 */
function isPositionClose(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= POSITION_TOLERANCE;
}

/**
 * Check if an optimistic operation has expired (stale).
 * Stale operations should be cleared to prevent UI inconsistency.
 */
export function isOperationStale(
  operation: OptimisticOperation,
  timeoutMs: number = 2000,
): boolean {
  return Date.now() - operation.timestamp > timeoutMs;
}
