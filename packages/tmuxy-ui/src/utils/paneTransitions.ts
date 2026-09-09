/**
 * Geometry inference for the pane enter animation (the split morph).
 *
 * PaneLayout diffs each render's pixel boxes against the previous render's.
 * When a pane appears, its animation starts from the pre-split box of the
 * sibling that shrank to make room. (A pane that disappears needs no
 * inference: it shrinks into its own centre where it was.) Working in pixel
 * space on rect overlap (rather than tmux cell adjacency) makes the
 * inference generic: splits initiated from the CLI or another client
 * animate exactly like optimistic local ones, and non-full-edge sources
 * are covered too.
 */

import type { PaneBox } from '../constants';

// Minimum share of the subject pane's area a candidate must overlap to be
// considered its split-source — guards against picking an
// unrelated pane that merely shifted a few pixels.
const MIN_OVERLAP_RATIO = 0.5;

export function rectOverlapArea(a: PaneBox, b: PaneBox): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function boxesEqual(a: PaneBox, b: PaneBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * Starting box for a newly appeared pane: the *previous* box of the pane
 * that shrank to make room for it (the split source) — found as the pane
 * present in both renders whose box changed and whose previous box overlaps
 * the new pane's final box the most. Returns null (caller fades in place)
 * when nothing plausible shrank, e.g. a pane appearing in a fresh window.
 */
export function findEnterFromBox(
  newBox: PaneBox,
  prevBoxes: ReadonlyMap<string, PaneBox>,
  currBoxes: ReadonlyMap<string, PaneBox>,
): PaneBox | null {
  let best: PaneBox | null = null;
  let bestArea = newBox.width * newBox.height * MIN_OVERLAP_RATIO;
  for (const [key, prevBox] of prevBoxes) {
    const currBox = currBoxes.get(key);
    if (!currBox || boxesEqual(prevBox, currBox)) continue;
    const area = rectOverlapArea(prevBox, newBox);
    if (area > bestArea) {
      bestArea = area;
      best = prevBox;
    }
  }
  return best;
}
