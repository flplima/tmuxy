/**
 * The slide between the phone's tree and its side pane (components/
 * PhoneBottomView.tsx): one view under the finger, the other riding beside
 * it on the side the finger pulls from, as a tab slide shows both tabs. The
 * commit rule, the settle time and the curve are the tab slide's own
 * (utils/gestures.ts), so the two gestures feel like one.
 *
 * Pure: the component owns the DOM and the timer.
 */

import { swipeCommits, swipeSettleMs } from './gestures';

export type BottomView = 'tree' | 'dock';

/** The side the other view is drawn on: where the finger pulls from. */
export type NeighborSide = 'left' | 'right';

export interface BottomSlideRelease {
  /** Where the track settles, px from rest: a view's width to the side, or 0. */
  target: number;
  /** Whether the other view ends up in front. */
  flips: boolean;
  /** How long the settle takes, ms. */
  settleMs: number;
}

/** The other view. */
export function otherView(view: BottomView): BottomView {
  return view === 'tree' ? 'dock' : 'tree';
}

/** Fingers moving right pull the other view in from the left. */
export function neighborSide(dx: number): NeighborSide | null {
  if (dx === 0) return null;
  return dx > 0 ? 'left' : 'right';
}

/**
 * Where a released slide goes: on past the view's edge, the other view
 * landing in front, when the tab slide's rule commits it — a flick, or a
 * release projected past the commit mark — and back to rest otherwise.
 */
export function releaseBottomSlide(dx: number, speed: number, width: number): BottomSlideRelease {
  const flips = swipeCommits(dx, speed, width);
  const target = flips ? Math.sign(dx) * width : 0;
  return { target, flips, settleMs: swipeSettleMs(target - dx, speed) };
}
