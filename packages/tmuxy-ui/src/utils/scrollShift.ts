/**
 * scrollShift — detect that a new terminal frame is a vertical scroll of the
 * previous one.
 *
 * Pure, dependency-free, and unit-testable. Given the previous and next visible
 * grids, it returns a signed line shift `k` describing how the content moved,
 * or 0 when no confident shift can be inferred (a full redraw, a big jump, a
 * blank screen). The scroll-shift animation hook uses `k` to slide the content
 * from its old position to its new one; when `k === 0` it does not animate.
 *
 * Sign convention: `next[i] ≈ prev[i - k]`.
 *   - `k > 0`: content moved DOWN by k rows — a line appeared at the top
 *     (scrolling up into history).
 *   - `k < 0`: content moved UP by |k| rows — a line appeared at the bottom
 *     (a log tail, scrolling down).
 *
 * The animation starts the rendered grid at `translateY(-k * lineHeight)` (its
 * old position) and transitions to 0.
 */

import type { PaneContent, CellLine } from '../tmux/types';

export interface ShiftOptions {
  /** Minimum fraction of comparable rows that must match to accept a shift. */
  minMatchRatio?: number;
  /** Maximum |k| as a fraction of grid height (1 = up to height-1). */
  maxShiftFraction?: number;
  /** Minimum number of non-blank comparable rows required to trust a score. */
  minComparable?: number;
}

const DEFAULTS: Required<ShiftOptions> = {
  minMatchRatio: 0.6,
  maxShiftFraction: 1,
  minComparable: 3,
};

/** A cell line is blank if it has no non-space characters. */
function isBlankLine(line: CellLine): boolean {
  for (const cell of line) {
    if (cell.c !== ' ' && cell.c !== '') return false;
  }
  return true;
}

function isAllBlank(content: PaneContent): boolean {
  for (const line of content) {
    if (!isBlankLine(line)) return false;
  }
  return true;
}

/**
 * Compare two lines by character content (ignoring style). Style differences
 * (cursor/selection highlight) must not break scroll detection. Reference
 * equality is the fast path — `deltaProtocol.ts` preserves unchanged CellLine
 * references across updates.
 */
function linesEqual(a: CellLine, b: CellLine): boolean {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a[i]?.c ?? ' ';
    const cb = b[i]?.c ?? ' ';
    if ((ca === '' ? ' ' : ca) !== (cb === '' ? ' ' : cb)) return false;
  }
  return true;
}

/** Score a candidate shift k: fraction of non-blank overlapping rows that match. */
function scoreShift(
  prev: PaneContent,
  next: PaneContent,
  k: number,
  height: number,
): { matches: number; comparable: number } {
  let matches = 0;
  let comparable = 0;
  for (let i = 0; i < height; i++) {
    const j = i - k;
    if (j < 0 || j >= height) continue; // newly revealed row — no counterpart
    const nextLine = next[i];
    const prevLine = prev[j];
    // Ignore blank-on-blank matches: a mostly-empty screen would otherwise
    // score high at many shifts.
    if (isBlankLine(nextLine) && isBlankLine(prevLine)) continue;
    comparable++;
    if (linesEqual(nextLine, prevLine)) matches++;
  }
  return { matches, comparable };
}

/**
 * Detect a vertical scroll shift between two frames. Returns the signed shift
 * `k` (see module docs) or 0 when no confident shift is inferable.
 */
export function detectVerticalShift(
  prev: PaneContent | undefined | null,
  next: PaneContent | undefined | null,
  opts: ShiftOptions = {},
): number {
  if (!prev || !next || prev === next) return 0;
  if (next.length === 0 || prev.length === 0) return 0;
  // A large change in row count is a layout/redraw, not a scroll.
  if (Math.abs(prev.length - next.length) > 2) return 0;
  if (isAllBlank(next)) return 0;

  const { minMatchRatio, maxShiftFraction, minComparable } = { ...DEFAULTS, ...opts };
  const height = Math.min(prev.length, next.length);
  if (height < 2) return 0;

  const maxK = Math.min(height - 1, Math.floor(height * maxShiftFraction));
  if (maxK < 1) return 0;

  let best = 0;
  let bestScore = 0;
  // Search outward from ±1 and prefer the smallest |k| (a 1-line scroll is the
  // common case and the simplest explanation). Early-exit on a high-confidence
  // hit so typical log-tail/less scrolls resolve immediately.
  for (let mag = 1; mag <= maxK; mag++) {
    for (const k of [mag, -mag]) {
      const { matches, comparable } = scoreShift(prev, next, k, height);
      if (comparable < minComparable) continue;
      const score = matches / comparable;
      if (score >= 0.9 && score >= minMatchRatio) return k; // confident, minimal |k|
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
  }

  return bestScore >= minMatchRatio ? best : 0;
}
