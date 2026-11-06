/**
 * The slide between the phone's three bottom views (PhoneBottomView.tsx),
 * laid side by side: the menu, the tree, the side pane. One view is under
 * the finger and its neighbour rides beside it on the side
 * the finger pulls from, as a tab slide shows both tabs. A finger pulling
 * past an end, where there is no view, moves the view a third as far and
 * lets it go back. The commit rule, the settle time and the curve are the
 * tab slide's own (machines/gestures/gestures.ts), so the two gestures feel
 * like one.
 *
 * Pure: the component owns the DOM and the timer.
 */

import { swipeCommits, swipeSettleMs } from '../../machines/gestures/gestures';
import type { BottomView } from '../../machines/types/domain';

/** The views, left to right: what a tab bar lists and a slide walks. */
export const BOTTOM_VIEWS: readonly BottomView[] = ['menu', 'tree', 'dock'];

/** The side a neighbour is drawn on: where the finger pulls from. */
export type NeighborSide = 'left' | 'right';

/** Past an end the view follows a third of the finger's travel. */
export const EDGE_RESISTANCE = 1 / 3;

export interface BottomSlideRelease {
  /** Where the track settles, px from rest: a view's width to the side, or 0. */
  target: number;
  /** The view in front once it has settled, when it is another. */
  next: BottomView | null;
  /** How long the settle takes, ms. */
  settleMs: number;
}

/** Fingers moving right pull the view on the left in. */
export function neighborSide(dx: number): NeighborSide | null {
  if (dx === 0) return null;
  return dx > 0 ? 'left' : 'right';
}

/** The view beside `view` on `side`, or null at that end. */
export function neighborView(view: BottomView, side: NeighborSide): BottomView | null {
  const at = BOTTOM_VIEWS.indexOf(view) + (side === 'left' ? -1 : 1);
  return BOTTOM_VIEWS[at] ?? null;
}

/** How far the track moves for a finger `dx` from where it landed. */
export function trackOffset(view: BottomView, dx: number): number {
  const side = neighborSide(dx);
  if (!side || neighborView(view, side)) return dx;
  return dx * EDGE_RESISTANCE;
}

/**
 * Where a released slide goes: on past the view's edge, the neighbour landing
 * in front, when the tab slide's rule commits it (a flick, or a release
 * projected past the commit mark) and there is a neighbour that way; back to
 * rest otherwise.
 */
export function releaseBottomSlide(
  view: BottomView,
  dx: number,
  speed: number,
  width: number,
): BottomSlideRelease {
  const side = neighborSide(dx);
  const next = side ? neighborView(view, side) : null;
  const moved = trackOffset(view, dx);
  const flips = next !== null && swipeCommits(dx, speed, width);
  const target = flips ? Math.sign(dx) * width : 0;
  return { target, next: flips ? next : null, settleMs: swipeSettleMs(target - moved, speed) };
}
