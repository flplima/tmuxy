/**
 * How far a divider can actually be dragged.
 *
 * tmux will not shrink a pane below one cell, so a drag that asks for more
 * than the panes on the far side can give up is simply refused — and until it
 * is refused the preview keeps drawing a layout that will never exist: the
 * pane on the near side grows past the pointer while the one across the line
 * bottoms out at one cell, and the two overlap. Clamping the DRAG rather than
 * each pane keeps the whole band consistent, so what is drawn is what tmux
 * will do, and the divider simply stops where tmux would stop it.
 *
 * The limits are computed once, from the geometry frozen at the start of the
 * drag (`ResizeState.originalGeometry`), for the same reason the preview is:
 * tmux's intermediate `%layout-change` events mid-resize are internally
 * inconsistent, and limits recomputed from them would drift.
 */

import type { ResizeHandle, ResizeLimits, PaneCellBox } from '../types';

/**
 * The smallest pane tmux will leave behind: one cell on the resized axis.
 * A one-row pane is a real thing in tmuxy — a collapsed row in a stack draws
 * exactly that, its header and nothing else.
 */
export const PANE_MIN_CELLS = 1;

/** No room in either direction: the divider is pinned. */
export const LOCKED_LIMITS: ResizeLimits = { min: 0, max: 0 };

/**
 * Which panes a drag on this handle grows, and which it shrinks.
 *
 * "Grow" and "shrink" are with respect to a POSITIVE delta, i.e. the pointer
 * moving right or down. A `w`/`n` handle moves the pane's own leading edge, so
 * there the pane itself is the one that shrinks.
 */
function bands(
  geometry: Record<string, PaneCellBox>,
  edge: number,
  handle: ResizeHandle,
): { grows: PaneCellBox[]; shrinks: PaneCellBox[] } {
  const grows: PaneCellBox[] = [];
  const shrinks: PaneCellBox[] = [];
  for (const box of Object.values(geometry)) {
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    if (handle === 'e') {
      if (right === edge) grows.push(box);
      else if (box.x === edge + 1) shrinks.push(box);
    } else if (handle === 'w') {
      if (box.x === edge) shrinks.push(box);
      else if (right === edge - 1) grows.push(box);
    } else if (handle === 's') {
      // The gap below a pane is one row of separator in tmux, two in the demo
      // engine (separator plus the header the next pane draws).
      if (bottom === edge) grows.push(box);
      else if (box.y === edge + 1 || box.y === edge + 2) shrinks.push(box);
    } else {
      if (box.y === edge) shrinks.push(box);
      else if (bottom === edge - 1 || bottom === edge - 2) grows.push(box);
    }
  }
  return { grows, shrinks };
}

/** The coordinate of the edge a handle drags, in cells. */
export function draggedEdge(box: PaneCellBox, handle: ResizeHandle): number {
  if (handle === 'e') return box.x + box.width;
  if (handle === 'w') return box.x;
  if (handle === 's') return box.y + box.height;
  return box.y;
}

/**
 * How many cells the drag may move, as a signed range around zero.
 *
 * Positive is the pointer moving right (`e`/`w`) or down (`s`/`n`). Both ends
 * are the room the panes being shrunk have left before one of them would hit
 * `PANE_MIN_CELLS`; a band with nothing on one side cannot move that way at
 * all, which is what pins a divider at the edge of the window.
 */
export function resizeLimits(
  geometry: Record<string, PaneCellBox>,
  paneId: string,
  handle: ResizeHandle,
): ResizeLimits {
  const target = geometry[paneId];
  if (!target) return LOCKED_LIMITS;
  const axis = handle === 'e' || handle === 'w' ? 'width' : 'height';
  const { grows, shrinks } = bands(geometry, draggedEdge(target, handle), handle);
  if (grows.length === 0 || shrinks.length === 0) return LOCKED_LIMITS;
  const room = (boxes: PaneCellBox[]) =>
    Math.max(0, Math.min(...boxes.map((b) => b[axis] - PANE_MIN_CELLS)));
  const back = room(grows);
  // `-0` is a real value that compares equal to 0 but does not serialise or
  // print like it; a limit of "no room" should be plain zero.
  return { min: back === 0 ? 0 : -back, max: room(shrinks) };
}

/** Hold a drag delta inside what the layout can give. */
export function clampDelta(delta: number, limits: ResizeLimits | undefined): number {
  if (!limits) return delta;
  return Math.min(limits.max, Math.max(limits.min, delta));
}

/** Whether a divider has nowhere to go, so grabbing it would do nothing. */
export function isLocked(limits: ResizeLimits): boolean {
  return limits.min === 0 && limits.max === 0;
}
