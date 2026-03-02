/**
 * Optimistic Updates Module
 *
 * Provides instant UI feedback for pane operations before server confirmation.
 */

export { parseCommand, isOptimisticCommand } from './commandParser';
export type {
  ParsedCommand,
  SplitCommand,
  NavigateCommand,
  SwapCommand,
  SelectPaneCommand,
  NewWindowCommand,
  SelectWindowCommand,
} from './commandParser';

export {
  calculatePrediction,
  applySplitPrediction,
  applySwapPrediction,
  applyNavigatePrediction,
  applyNewWindowPrediction,
  applySelectWindowPrediction,
} from './predictions';

export { reconcileOptimisticUpdate, isOperationStale } from './reconcile';
export type { ReconciliationResult } from './reconcile';
