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

export interface RenderLogEntry {
  readonly id: string;
  readonly ts: number;
}

export interface RenderLog {
  readonly entries: RenderLogEntry[];
}

const MAX_ENTRIES = 50000;

function getLog(): RenderLog | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __tmuxyRenderLog?: RenderLog }).__tmuxyRenderLog;
}

/**
 * Install (or reset) the render log. Call BEFORE mounting the app — the
 * `LogProfiler` markers check for the log at render time.
 */
export function enableRenderLog(): RenderLog {
  const log: RenderLog = { entries: [] };
  (window as unknown as { __tmuxyRenderLog?: RenderLog }).__tmuxyRenderLog = log;
  return log;
}

/** Current log length — pass to `renderCountSince` to scope an assertion. */
export function renderLogMark(): number {
  return getLog()?.entries.length ?? 0;
}

/** Renders since `mark` whose id starts with `idPrefix`. */
export function renderCountSince(mark: number, idPrefix: string): number {
  const log = getLog();
  if (!log) return 0;
  let count = 0;
  for (let i = mark; i < log.entries.length; i++) {
    if (log.entries[i].id.startsWith(idPrefix)) count++;
  }
  return count;
}

/** Distinct ids (with render counts) since `mark` — for debugging budgets. */
export function renderCountsById(mark: number): Record<string, number> {
  const log = getLog();
  const counts: Record<string, number> = {};
  if (!log) return counts;
  for (let i = mark; i < log.entries.length; i++) {
    const id = log.entries[i].id;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

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
