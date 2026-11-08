/**
 * The split morph's starting box, inferred from pixel-box overlap rather than
 * tmux cell adjacency, so splits from the CLI or another client animate like
 * optimistic local ones.
 */

import type { PaneBox } from '../domain/paneGeometry';

// Share of the new pane's area a split source must overlap, so a pane that
// merely shifted a few pixels is not taken for it.
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
 * The previous box of the pane that shrank to make room (the changed box
 * overlapping the new one most), or null when nothing plausible shrank.
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
