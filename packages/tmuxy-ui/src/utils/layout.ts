/**
 * Layout utility functions
 * Pure functions for pane layout calculations
 */

import type { TmuxPane } from '../machines/types';
import { CHAR_HEIGHT, STATUS_BAR_HEIGHT, TMUX_STATUS_BAR_HEIGHT, LAYOUT_INSET } from '../constants';

/**
 * Calculate target dimensions (cols/rows) based on window size
 */
export function calculateTargetSize(charWidth: number): { cols: number; rows: number } {
  const availableWidth = window.innerWidth - LAYOUT_INSET * 2;
  const availableHeight = window.innerHeight - STATUS_BAR_HEIGHT - TMUX_STATUS_BAR_HEIGHT - LAYOUT_INSET * 2;

  const cols = Math.floor(availableWidth / charWidth);
  const rows = Math.floor(availableHeight / CHAR_HEIGHT);

  return { cols: Math.max(10, cols), rows: Math.max(5, rows) };
}

/**
 * Divider segment representing a resize handle between panes
 */
export interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number;   // right for horizontal, bottom for vertical
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
