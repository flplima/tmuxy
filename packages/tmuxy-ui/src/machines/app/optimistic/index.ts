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
} from './commandParser';

export {
  calculatePrediction,
  applySplitPrediction,
  applySwapPrediction,
  applyNavigatePrediction,
  applyNewWindowPrediction,
} from './predictions';

export { reconcileOptimisticUpdate, isOperationStale } from './reconcile';
export type { ReconciliationResult } from './reconcile';
