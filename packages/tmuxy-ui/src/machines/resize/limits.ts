/**
 * The band a divider drag moves, and how far it can be dragged.
 *
 * Dragging one divider moves a BAND of panes: every pane ending on the dragged
 * edge grows or shrinks with it, and every pane starting just past the edge is
 * pushed along and resized the other way; nothing else moves. That one rule
 * is what the preview draws (`selectPreviewPanes`), what the model handler
 * waits for before it lets the preview go (`resizePreviewSettled`), and what
 * bounds the drag here.
 *
 * tmux will not shrink a pane below one cell, so a drag that asks for more
 * than the panes on the far side can give up is simply refused — and until it
 * is refused the preview keeps drawing a layout that will never exist: the
 * pane on the near side grows past the pointer while the one across the line
 * bottoms out at one cell, and the two overlap. Clamping the DRAG rather than
 * each pane keeps the whole band consistent, so what is drawn is what tmux
 * will do, and the divider simply stops where tmux would stop it.
 *
 * Everything is computed from the geometry frozen at the start of the drag
 * (`ResizeState.originalGeometry`): tmux's intermediate `%layout-change`
 * events mid-resize are internally inconsistent, and a band or a limit
 * recomputed from them would drift.
 */

import type { ResizeHandle, ResizeLimits, ResizeState, PaneCellBox } from '../types';
import type { PaneId } from '../../domain/ids';

/**
 * The smallest pane tmux will leave behind: one cell on the resized axis.
 * A one-row pane is a real thing in tmuxy — a collapsed row in a stack draws
 * exactly that, its header and nothing else.
 */
export const PANE_MIN_CELLS = 1;

/** No room in either direction: the divider is pinned. */
export const LOCKED_LIMITS: ResizeLimits = { min: 0, max: 0 };

/**
 * Which side of the dragged edge a pane is on: `before` panes end on the edge
 * and grow with a positive delta, `after` panes start just past it and are
 * pushed along and shrunk. "Positive" is the pointer moving right or down. A
 * `w`/`n` handle drags the pane's own leading edge, so there the pane itself
 * is on the `after` side.
 */
export type BandSide = 'before' | 'after';

const isVertical = (handle: ResizeHandle) => handle === 's' || handle === 'n';

/** The coordinate of the edge a handle drags, in cells. */
function draggedEdge(box: PaneCellBox, handle: ResizeHandle): number {
  if (handle === 'e') return box.x + box.width;
  if (handle === 'w') return box.x;
  if (handle === 's') return box.y + box.height;
  return box.y;
}

/** The side of `edge` a pane touches it from, or null for a pane the drag leaves alone. */
export function bandSide(box: PaneCellBox, edge: number, handle: ResizeHandle): BandSide | null {
  const vertical = isVertical(handle);
  const near = vertical ? box.y : box.x;
  const far = near + (vertical ? box.height : box.width);
  // The gap between the two panes is one separator cell in tmux, and two rows
  // in the demo engine (the separator plus the header the next pane draws).
  const gaps = vertical ? [1, 2] : [1];
  if (handle === 'e' || handle === 's') {
    if (far === edge) return 'before';
    return gaps.some((gap) => near === edge + gap) ? 'after' : null;
  }
  if (near === edge) return 'after';
  return gaps.some((gap) => far === edge - gap) ? 'before' : null;
}

/** `box` once the edge it touches on `side` has moved `delta` cells. */
function shifted(
  box: PaneCellBox,
  side: BandSide,
  handle: ResizeHandle,
  delta: number,
): PaneCellBox {
  if (isVertical(handle)) {
    return side === 'before'
      ? { ...box, height: Math.max(PANE_MIN_CELLS, box.height + delta) }
      : { ...box, y: box.y + delta, height: Math.max(PANE_MIN_CELLS, box.height - delta) };
  }
  return side === 'before'
    ? { ...box, width: Math.max(PANE_MIN_CELLS, box.width + delta) }
    : { ...box, x: box.x + delta, width: Math.max(PANE_MIN_CELLS, box.width - delta) };
}

/**
 * The cells a drag has moved its divider: its pixel delta along the handle's
 * axis, held inside the limits. The one number the drawn band, the settled
 * check and the commands all derive from.
 */
export function dragCells(
  resize: Pick<ResizeState, 'handle' | 'pixelDelta' | 'limits'>,
  charWidth: number,
  charHeight: number,
): number {
  const cells = isVertical(resize.handle)
    ? Math.round(resize.pixelDelta.y / charHeight)
    : Math.round(resize.pixelDelta.x / charWidth);
  return clampDelta(cells, resize.limits);
}

/**
 * The boxes that move once `paneId`'s `handle` edge has travelled `delta`
 * cells, keyed by pane. Panes the drag leaves alone are not listed; nothing is
 * when the pane is not in the geometry, since then there is no edge to drag.
 */
export function resizedBand(
  geometry: Record<PaneId, PaneCellBox>,
  paneId: PaneId,
  handle: ResizeHandle,
  delta: number,
): Record<PaneId, PaneCellBox> {
  const target = geometry[paneId];
  if (!target) return {};
  const edge = draggedEdge(target, handle);
  const band: Record<PaneId, PaneCellBox> = {};
  for (const id of Object.keys(geometry) as PaneId[]) {
    const side = bandSide(geometry[id], edge, handle);
    if (side) band[id] = shifted(geometry[id], side, handle, delta);
  }
  return band;
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
  geometry: Record<PaneId, PaneCellBox>,
  paneId: PaneId,
  handle: ResizeHandle,
): ResizeLimits {
  const target = geometry[paneId];
  if (!target) return LOCKED_LIMITS;
  const axis = isVertical(handle) ? 'height' : 'width';
  const edge = draggedEdge(target, handle);
  const grows: PaneCellBox[] = [];
  const shrinks: PaneCellBox[] = [];
  for (const box of Object.values(geometry)) {
    const side = bandSide(box, edge, handle);
    if (side === 'before') grows.push(box);
    else if (side === 'after') shrinks.push(box);
  }
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
