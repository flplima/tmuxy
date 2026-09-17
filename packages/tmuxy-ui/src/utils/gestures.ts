/**
 * Geometry for trackpad gestures: which tab a slide pulls in, whether a gesture
 * commits, and where the pane grid (or one pane) is drawn while it runs.
 *
 * Pure functions, shared by the gesture actions (what a gesture commits to),
 * GestureStage (how it is drawn) and PaneLayout (which panes it involves).
 */

import type { GestureState, TmuxWindow } from '../machines/types';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far past either end of the strip the grid can be pulled, as a share of the pane area's width. */
export const SWIPE_EDGE_LIMIT_SHARE = 0.2;
/**
 * Where a slide must reach, as a share of the pane area's width, to switch
 * tabs: half way, like a native page swipe. A slide that stops short of it
 * settles back unless it was still moving when it was released - which is what
 * `SWIPE_PROJECT_MS` carries a flick past.
 */
export const SWIPE_COMMIT_SHARE = 0.5;
/** How far ahead a release is projected at the speed the fingers had. */
export const SWIPE_PROJECT_MS = 120;
/** The gap between one tab and the next while a slide is showing both. */
export const SWIPE_GUTTER_PX = 24;
/** A released slide is never quicker than this, nor slower. */
export const SWIPE_SETTLE_MIN_MS = 90;
export const SWIPE_SETTLE_MAX_MS = 320;
/** Ease-out that keeps the speed the fingers had and decelerates into place, never past it. */
export const SWIPE_EASING = 'cubic-bezier(0.25, 0.9, 0.3, 1)';
/** A pinch out past this zooms the pane / enters the tab when the fingers lift. */
export const PINCH_OUT_COMMIT = 1.2;
/** A pinch in past this unzooms / opens the "all tabs" view when the fingers lift. */
export const PINCH_IN_COMMIT = 0.85;
/** The grid follows a pinch in down to this scale. */
export const PINCH_MIN_SCALE = 0.4;
/** The pinch-out scale at which a growing pane (or grid) has reached full size. */
const PINCH_OUT_FULL = 1.6;

/** The tab a slide by `dx` pulls in: fingers moving left bring in the next one. */
export function neighborTab(
  tabs: readonly TmuxWindow[],
  activeWindowId: string | null,
  dx: number,
): TmuxWindow | null {
  if (dx === 0) return null;
  const i = tabs.findIndex((w) => w.id === activeWindowId);
  if (i === -1) return null;
  return tabs[dx < 0 ? i + 1 : i - 1] ?? null;
}

/** `windowId:side` from selectSwipeNeighbor, as `[windowId, side]` (side 0 when there is none). */
export function parseSwipeNeighbor(value: string | null): [string | null, number] {
  if (!value) return [null, 0];
  const at = value.lastIndexOf(':');
  return [value.slice(0, at), Number(value.slice(at + 1))];
}

/**
 * How far the grid is drawn from rest while the fingers pull it past the end of
 * the strip: it follows them less and less, and never gets further than the
 * limit, the way a native list does at its end.
 */
export function rubberBand(dx: number, width: number): number {
  const limit = width * SWIPE_EDGE_LIMIT_SHARE;
  return (dx * limit) / (limit + Math.abs(dx));
}

/**
 * Whether a released slide switches tabs: where it would land, carried on at
 * the speed the fingers had (px/ms, signed), is past the commit share. That
 * takes a flick as far as its speed says, and lets a slide pulled back as it
 * is released settle where it started.
 */
export function swipeCommits(dx: number, speed: number, width: number): boolean {
  if (dx === 0) return false;
  const projected = dx + speed * SWIPE_PROJECT_MS;
  return (
    Math.sign(projected) === Math.sign(dx) && Math.abs(projected) >= width * SWIPE_COMMIT_SHARE
  );
}

/** How long a released slide takes to cover `remaining` px at `speed` px/ms. */
export function swipeSettleMs(remaining: number, speed: number): number {
  const ms = Math.abs(remaining) / Math.max(Math.abs(speed), 0.1);
  return Math.round(Math.min(SWIPE_SETTLE_MAX_MS, Math.max(SWIPE_SETTLE_MIN_MS, ms)));
}

/**
 * How far to the side the tab being pulled in is drawn, and how far a
 * committed slide travels: one tab's panes wide plus the gutter, so the two
 * tabs sit an even gap apart however the grid is centred. A pane spans one
 * cell more than its cells (the mosaic border it shares with its neighbour or
 * the grid edge), which is what makes the gap exactly the gutter.
 */
export function swipeOffsetPx(gridCols: number, charWidth: number): number {
  return (gridCols + 1) * charWidth + SWIPE_GUTTER_PX;
}

/** How GestureStage moves the grid: with the fingers, on the settle curve, or out of the overview card. */
export function gestureStageMode(
  gesture: GestureState | null,
): 'moving' | 'settling' | 'entering' | null {
  if (!gesture) return null;
  if (gesture.kind === 'swipe') {
    return gesture.phase === 'finishing' || gesture.phase === 'cancelling' ? 'settling' : 'moving';
  }
  return gesture.mode === 'enter' ? 'entering' : 'moving';
}

/** How far a pinch out has grown something toward full size, 0-1. */
export function pinchOutProgress(scale: number): number {
  return Math.max(0, Math.min(1, (scale - 1) / (PINCH_OUT_FULL - 1)));
}

/** The scale a pinch in draws the grid at. */
export function pinchInScale(scale: number): number {
  return Math.max(PINCH_MIN_SCALE, Math.min(1, scale));
}

/**
 * The transform the whole pane grid is drawn with, or null when the grid
 * belongs at rest (no gesture, a slide sliding back, a pinch that grows a
 * single pane, or the overview's card). Written for `transform-origin: 0 0`.
 *
 * For a `finishing` slide this is where the grid STARTS: the tab has already
 * switched, and GestureStage puts the grid here with no transition and runs it
 * home from there.
 *
 * `baseX` is where the grid already was when the slide began - non-zero only
 * when a new slide took over one still sliding home, which it then has to
 * carry on from rather than snap away from.
 */
export function gridGestureTransform(
  gesture: GestureState | null,
  width: number,
  height: number,
  baseX = 0,
): string | null {
  if (!gesture) return null;
  if (gesture.kind === 'swipe') {
    // Sliding back means "go to rest", wherever it started from.
    if (gesture.phase === 'cancelling') return null;
    const x =
      gesture.phase === 'tracking' && !gesture.neighborId
        ? rubberBand(gesture.dx, width)
        : gesture.dx;
    return `translate3d(${baseX + x}px, 0, 0)`;
  }
  if (gesture.mode === 'zoom' || gesture.mode === 'enter') return null;
  const s = pinchInScale(gesture.scale);
  return `translate(${((1 - s) * width) / 2}px, ${((1 - s) * height) / 2}px) scale(${s})`;
}

/** A pane growing under a pinch out: moved `pinchOutProgress` of the way from its slot to its zoomed box. */
export function zoomGrowBox(pane: Box, zoomed: Box, scale: number): Box {
  const p = pinchOutProgress(scale);
  return {
    left: pane.left + (zoomed.left - pane.left) * p,
    top: pane.top + (zoomed.top - pane.top) * p,
    width: pane.width + (zoomed.width - pane.width) * p,
    height: pane.height + (zoomed.height - pane.height) * p,
  };
}

/** Where a box inside a grid of `width` x `height` is drawn when a pinch in scales the grid about its centre. */
export function scaledBox(box: Box, scale: number, width: number, height: number): Box {
  const s = pinchInScale(scale);
  return {
    left: ((1 - s) * width) / 2 + s * box.left,
    top: ((1 - s) * height) / 2 + s * box.top,
    width: s * box.width,
    height: s * box.height,
  };
}

/**
 * The Tab Overview's FLIP transform - the live grid scaled into the current
 * tab's card, `translate(x, y) scale(sx, sy)` - drawn `progress` of the way
 * back to full size, for a pinch out of the overview.
 */
export function enterTransform(
  x: number,
  y: number,
  sx: number,
  sy: number,
  progress: number,
): string {
  const back = 1 - progress;
  return `translate(${x * back}px, ${y * back}px) scale(${sx + (1 - sx) * progress}, ${sy + (1 - sy) * progress})`;
}

/** The transform that draws an element laid out at `from` at `to` instead (`transform-origin: 0 0`). */
export function boxTransform(from: Box, to: Box): string {
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
}
