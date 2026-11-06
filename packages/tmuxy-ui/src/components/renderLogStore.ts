/**
 * The render log stories read: entries LogProfiler records, and counts over them.
 */

export interface RenderLogEntry {
  readonly id: string;
  readonly ts: number;
}

export interface RenderLog {
  readonly entries: RenderLogEntry[];
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

export function getLog(): RenderLog | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __tmuxyRenderLog?: RenderLog }).__tmuxyRenderLog;
}
