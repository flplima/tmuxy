/**
 * What one finger on a pane means (components/terminal/usePaneTouch.ts).
 *
 * A finger lands undecided. Moving past the slop decides it: mostly sideways
 * on a phone is a slide between tabs, otherwise it scrolls. Resting past the
 * hold time is a selection (the word under it, then the finger drags the
 * selection's end). Lifting inside the slop is a tap, and a second tap on the
 * same spot within the double-tap window is a double tap.
 */

export interface TouchPoint {
  x: number;
  y: number;
  /** The event's timestamp, ms. */
  t: number;
}

export type TouchIntent = 'undecided' | 'scroll' | 'swipe' | 'hold';

/** A finger that strays this far is moving, not tapping or holding. */
export const TAP_SLOP_PX = 10;
/** Resting this long, inside the slop, selects the word under the finger. */
export const HOLD_MS = 450;
/** Two taps this close in time and space are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;
/** Sideways travel has to beat vertical by this much to be a slide, not a scroll. */
const SWIPE_RATIO = 1.5;

export function decideIntent(start: TouchPoint, now: TouchPoint, canSwipe: boolean): TouchIntent {
  const dx = Math.abs(now.x - start.x);
  const dy = Math.abs(now.y - start.y);
  if (dx < TAP_SLOP_PX && dy < TAP_SLOP_PX) return 'undecided';
  if (canSwipe && dx > dy * SWIPE_RATIO) return 'swipe';
  return 'scroll';
}

export function isTap(start: TouchPoint, end: TouchPoint): boolean {
  return Math.abs(end.x - start.x) < TAP_SLOP_PX && Math.abs(end.y - start.y) < TAP_SLOP_PX;
}

export function isDoubleTap(previous: TouchPoint | null, tap: TouchPoint): boolean {
  if (!previous) return false;
  return (
    tap.t - previous.t <= DOUBLE_TAP_MS &&
    Math.abs(tap.x - previous.x) < DOUBLE_TAP_SLOP_PX &&
    Math.abs(tap.y - previous.y) < DOUBLE_TAP_SLOP_PX
  );
}

/**
 * The speed a slide is released at, px/ms, as the trackpad slide measures it
 * (machines/gestures/gestureActor.ts). Zero for too few samples.
 */
export function releaseSpeed(samples: readonly TouchPoint[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
}
