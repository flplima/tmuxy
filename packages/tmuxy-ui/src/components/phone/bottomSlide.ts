/**
 * The slide between the phone's three bottom views (PhoneBottomView.tsx). The
 * commit rule, the settle time and the curve are the tab slide's own
 * (machines/gestures/gestures.ts), so the two gestures feel like one.
 */

import { swipeCommits, swipeSettleMs } from '../../machines/gestures/gestures';
import type { BottomView } from '../../machines/types/domain';

/** Left to right. */
export const BOTTOM_VIEWS: readonly BottomView[] = ['menu', 'tree', 'dock'];

/** The side a neighbour is drawn on: where the finger pulls from. */
export type NeighborSide = 'left' | 'right';

export const EDGE_RESISTANCE = 1 / 3;

export interface BottomSlideRelease {
  /** Where the track settles, px from rest: a view's width to the side, or 0. */
  target: number;
  /** The view in front once it has settled, when it is another. */
  next: BottomView | null;
  /** How long the settle takes, ms. */
  settleMs: number;
}

export function neighborSide(dx: number): NeighborSide | null {
  if (dx === 0) return null;
  return dx > 0 ? 'left' : 'right';
}

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
