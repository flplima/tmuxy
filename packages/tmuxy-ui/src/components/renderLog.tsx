/**
 * Render logging for React render-efficiency budgets.
 *
 * `LogProfiler` records one entry per RENDER of the component it is placed
 * inside: it sits in that component's JSX, so its function body re-runs
 * exactly when the host component's body ran. The entry is appended during
 * render — an idempotent counter push, gated to test runs (the log object
 * only exists after `enableRenderLog()` was called BEFORE the app mounted).
 *
 * React's own <Profiler onRender> is deliberately NOT used: in this tree it
 * over-reports, firing for profilers whose entire subtree bailed out (verified
 * empirically — a memo'd pane with zero component-body executions still
 * produced onRender commits), which would make every isolation budget
 * meaningless.
 *
 * This catches wasted work MutationObserver cannot: a component that
 * re-renders but produces identical DOM still burns CPU on every state tick.
 */

import type { ReactNode } from 'react';
import { getLog } from './renderLogStore';

const MAX_ENTRIES = 50000;

/**
 * Render marker: records one log entry each time the surrounding component's
 * body runs. Place inside the component whose render count the budget guards.
 */
export function LogProfiler({ id, children }: { id: string; children?: ReactNode }): ReactNode {
  const log = getLog();
  if (log && log.entries.length < MAX_ENTRIES) {
    log.entries.push({ id, ts: performance.now() });
  }
  return children ?? null;
}
