/**
 * Layout utility functions
 * Pure functions for pane layout calculations
 */

import type { TmuxPane } from '../machines/types';
import {
  CHAR_HEIGHT,
  STATUS_BAR_HEIGHT,
  TMUX_STATUS_BAR_HEIGHT,
  CONTAINER_PADDING_X,
  CONTAINER_PADDING_BOTTOM,
} from '../constants';

/**
 * Calculate target dimensions (cols/rows) based on available space.
 *
 * When containerWidth/containerHeight are provided (the content box of
 * .pane-container from its ResizeObserver) they are used directly — the
 * container's padding is the grid's margin and .pane-layout fills the rest.
 *
 * Otherwise falls back to window dimensions with manual bar-height and
 * padding subtraction.
 *
 * When multiple clients are connected, the server uses the minimum cols/rows
 * across all clients (like native tmux behavior).
 */
export function calculateTargetSize(
  charWidth: number,
  containerWidth?: number,
  containerHeight?: number,
): { cols: number; rows: number } {
  const availableWidth =
    containerWidth != null ? containerWidth : window.innerWidth - CONTAINER_PADDING_X * 2;
  const availableHeight =
    containerHeight != null
      ? containerHeight
      : window.innerHeight - STATUS_BAR_HEIGHT - TMUX_STATUS_BAR_HEIGHT - CONTAINER_PADDING_BOTTOM;

  const cols = Math.floor(availableWidth / charWidth);
  const rows = Math.floor(availableHeight / CHAR_HEIGHT);

  return { cols: Math.max(10, cols), rows: Math.max(5, rows) };
}

/**
 * Divider segment representing a resize handle between panes
 */
export interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number; // right for horizontal, bottom for vertical
  paneId: string; // pane to resize
}

/**
 * Merge adjacent/overlapping segments at each position
 */
export function mergeSegments(segments: DividerSegment[]): DividerSegment[] {
  if (segments.length <= 1) return segments;

  // Sort by start position
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: DividerSegment[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Check if segments are adjacent or overlapping (allow 1-cell gap for tmux divider)
    if (next.start <= current.end + 1) {
      // Merge: extend current segment
      current.end = Math.max(current.end, next.end);
    } else {
      // Gap: push current and start new
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}

/**
 * Collect divider segments from pane layout
 */
export function collectDividerSegments(panes: TmuxPane[]): {
  horizontal: Map<number, DividerSegment[]>;
  vertical: Map<number, DividerSegment[]>;
} {
  const horizontalDividers = new Map<number, DividerSegment[]>();
  const verticalDividers = new Map<number, DividerSegment[]>();

  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];

    for (let j = i + 1; j < panes.length; j++) {
      const other = panes[j];

      // Horizontal divider: panes share a horizontal edge (with 1-cell tmux divider gap)
      const horizontallyOverlap = pane.x < other.x + other.width && pane.x + pane.width > other.x;

      if (pane.y + pane.height + 1 === other.y && horizontallyOverlap) {
        // pane is above other
        const yPos = pane.y + pane.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);

        if (!horizontalDividers.has(yPos)) {
          horizontalDividers.set(yPos, []);
        }
        horizontalDividers.get(yPos)!.push({
          start: left,
          end: right,
          paneId: pane.tmuxId,
        });
      } else if (other.y + other.height + 1 === pane.y && horizontallyOverlap) {
        // other is above pane (reversed order in array)
        const yPos = other.y + other.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);

        if (!horizontalDividers.has(yPos)) {
          horizontalDividers.set(yPos, []);
        }
        horizontalDividers.get(yPos)!.push({
          start: left,
          end: right,
          paneId: other.tmuxId,
        });
      }

      // Vertical divider: panes share a vertical edge (with 1-cell tmux divider gap)
      const verticallyOverlap = pane.y < other.y + other.height && pane.y + pane.height > other.y;

      if (pane.x + pane.width + 1 === other.x && verticallyOverlap) {
        // pane is to the left of other
        const xPos = pane.x + pane.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);

        if (!verticalDividers.has(xPos)) {
          verticalDividers.set(xPos, []);
        }
        verticalDividers.get(xPos)!.push({
          start: top,
          end: bottom,
          paneId: pane.tmuxId,
        });
      } else if (other.x + other.width + 1 === pane.x && verticallyOverlap) {
        // other is to the left of pane (reversed order in array)
        const xPos = other.x + other.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);

        if (!verticalDividers.has(xPos)) {
          verticalDividers.set(xPos, []);
        }
        verticalDividers.get(xPos)!.push({
          start: top,
          end: bottom,
          paneId: other.tmuxId,
        });
      }
    }
  }

  return { horizontal: horizontalDividers, vertical: verticalDividers };
}

/**
 * The pane tmux has zoomed, identified by geometry: while a window is zoomed
 * tmux reports the zoomed pane spanning the whole grid — from the grid's
 * top-left corner to its bottom-right — while every other pane keeps its
 * pre-zoom box. Only the zoomed pane covers both corners; the bottom-right
 * pane of any layout also touches the far corner, and checking that corner
 * alone (as this used to) picked it instead, hiding the pane the user had
 * just zoomed. Returns null when no pane spans the grid.
 */
export function findZoomedPane<P extends Pick<TmuxPane, 'x' | 'y' | 'width' | 'height'>>(
  panes: readonly P[],
): P | null {
  if (panes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = 0;
  let maxBottom = 0;
  for (const p of panes) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxRight = Math.max(maxRight, p.x + p.width);
    maxBottom = Math.max(maxBottom, p.y + p.height);
  }
  return (
    panes.find(
      (p) => p.x <= minX && p.y <= minY && p.x + p.width >= maxRight && p.y + p.height >= maxBottom,
    ) ?? null
  );
}
