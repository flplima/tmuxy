/**
 * The slide between the phone's tree and its side pane (PhoneBottomView.tsx).
 * The commit rule, the settle time and the curve are the tab slide's own
 * (machines/gestures/gestures.ts), so the two gestures feel like one.
 */

import { swipeCommits, swipeSettleMs } from '../../machines/gestures/gestures';

export type BottomView = 'tree' | 'dock';

/** The side the other view is drawn on: where the finger pulls from. */
export type NeighborSide = 'left' | 'right';

export interface BottomSlideRelease {
  /** Where the track settles, px from rest: a view's width to the side, or 0. */
  target: number;
  flips: boolean;
  /** How long the settle takes, ms. */
  settleMs: number;
}

export function otherView(view: BottomView): BottomView {
  return view === 'tree' ? 'dock' : 'tree';
}

/** Fingers moving right pull the other view in from the left. */
export function neighborSide(dx: number): NeighborSide | null {
  if (dx === 0) return null;
  return dx > 0 ? 'left' : 'right';
}

/**
 * Where a released slide goes: a view's width to the side when the tab slide's
 * rule commits it, else back to rest.
 */
export function releaseBottomSlide(dx: number, speed: number, width: number): BottomSlideRelease {
  const flips = swipeCommits(dx, speed, width);
  const target = flips ? Math.sign(dx) * width : 0;
  return { target, flips, settleMs: swipeSettleMs(target - dx, speed) };
}
