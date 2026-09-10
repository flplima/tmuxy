/**
 * Telling one kind of geometry change from another.
 *
 * A pane's box can change for reasons that want opposite treatment on screen.
 * A resize or a stack navigation changes how big the panes ARE, and reads far
 * better animated — the eye can follow a row opening up. A swap changes only
 * WHICH pane is in which box, and must not animate: the two panes would slide
 * through each other on the way past.
 *
 * The difference is visible in the boxes themselves. A swap is a permutation —
 * the same set of boxes, handed to different panes — so the multiset of boxes
 * is identical before and after. Anything that resizes changes the boxes.
 */

interface Boxed {
  tmuxId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxKeys(panes: readonly Boxed[]): string[] {
  return panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`).sort();
}

/**
 * Whether the panes merely traded boxes: the same boxes are occupied, by
 * different panes. True for a swap, false for anything that resized.
 *
 * A pane appearing or disappearing is not a permutation either — the counts
 * differ — which is right: splits and kills have their own morph and must not
 * be treated as a plain geometry change.
 */
export function isBoxPermutation(prev: readonly Boxed[], next: readonly Boxed[]): boolean {
  if (prev.length !== next.length) return false;
  const before = boxKeys(prev);
  const after = boxKeys(next);
  return before.every((key, i) => key === after[i]);
}

/** Whether the same panes are present, by id, in both snapshots. */
export function samePanes(prev: readonly Boxed[], next: readonly Boxed[]): boolean {
  if (prev.length !== next.length) return false;
  const ids = new Set(prev.map((p) => p.tmuxId));
  return next.every((p) => ids.has(p.tmuxId));
}
