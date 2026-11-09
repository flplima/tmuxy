/**
 * What a prediction is given and what it gives back: the shapes ops.ts and the
 * predictors beside it (paneOps.ts, windowOps.ts, joinPane.ts) share. Here,
 * not in ops.ts, which imports the predictors: they would import it back.
 */

import type { PaneId } from '../ids';
import type { Patch } from './types';

export interface PredictContext {
  readonly defaultShell: string;
  /** MRU pane order, used by Navigate to break overlap ties (mirrors tmux's
   *  window_pane_choose_best ranking by active_point). */
  readonly paneActivationOrder: ReadonlyArray<PaneId>;
}

export interface PredictResult {
  readonly patch: Patch;
  readonly meta: Readonly<Record<string, unknown>>;
}
