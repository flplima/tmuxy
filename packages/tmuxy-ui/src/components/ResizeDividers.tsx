/**
 * ResizeDividers - Renders resize handles between adjacent panes.
 *
 * Scans pane pairs to find shared edges (with 1-cell tmux divider gap),
 * merges overlapping segments, and renders invisible clickable dividers.
 *
 * Keys use sequential indices (divider-0, divider-1, ...) in a canonical
 * sort order so React reconciles existing DOM nodes in-place across resize,
 * layout cycle, and split/placeholder-swap operations. The total number of
 * dividers is N-1 for N panes in standard tmux layouts, so the count (and
 * therefore the keys) stays constant when only positions/orientations change.
 */

import React from 'react';
import { useAppSend } from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';
import { haptics } from '../utils/haptics';

interface ResizeDividersProps {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  centeringOffset: { x: number; y: number };
}

interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number; // right for horizontal, bottom for vertical
  paneId: string; // pane to resize
}

/** A fully resolved divider with orientation and axis position */
interface ResolvedDivider {
  orientation: 'h' | 'v';
  axisPos: number; // yPos for horizontal, xPos for vertical
  start: number;
  end: number;
  paneId: string;
}

/** Merge adjacent/overlapping segments at a given divider position */
function mergeSegments(segments: DividerSegment[]): DividerSegment[] {
  if (segments.length <= 1) return segments;

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: DividerSegment[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Adjacent or overlapping (allow 1-cell gap for tmux divider)
    if (next.start <= current.end + 1) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}

/** Collect horizontal and vertical divider segments from pane adjacency */
function collectDividerSegments(panes: TmuxPane[]) {
  const horizontal = new Map<number, DividerSegment[]>();
  const vertical = new Map<number, DividerSegment[]>();

  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];

    for (let j = i + 1; j < panes.length; j++) {
      const other = panes[j];

      // Horizontal divider: panes share a horizontal edge.
      // Gap is 1 (real tmux) or 2 (demo: separator + header row).
      const horizontallyOverlap = pane.x < other.x + other.width && pane.x + pane.width > other.x;
      const hGapAB = other.y - (pane.y + pane.height);
      const hGapBA = pane.y - (other.y + other.height);

      if ((hGapAB === 1 || hGapAB === 2) && horizontallyOverlap) {
        const yPos = pane.y + pane.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);
        if (!horizontal.has(yPos)) horizontal.set(yPos, []);
        horizontal.get(yPos)!.push({ start: left, end: right, paneId: pane.tmuxId });
      } else if ((hGapBA === 1 || hGapBA === 2) && horizontallyOverlap) {
        const yPos = other.y + other.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);
        if (!horizontal.has(yPos)) horizontal.set(yPos, []);
        horizontal.get(yPos)!.push({ start: left, end: right, paneId: other.tmuxId });
      }

      // Vertical divider: panes share a vertical edge (with 1-cell tmux divider gap)
      const verticallyOverlap = pane.y < other.y + other.height && pane.y + pane.height > other.y;

      if (pane.x + pane.width + 1 === other.x && verticallyOverlap) {
        const xPos = pane.x + pane.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);
        if (!vertical.has(xPos)) vertical.set(xPos, []);
        vertical.get(xPos)!.push({ start: top, end: bottom, paneId: pane.tmuxId });
      } else if (other.x + other.width + 1 === pane.x && verticallyOverlap) {
        const xPos = other.x + other.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);
        if (!vertical.has(xPos)) vertical.set(xPos, []);
        vertical.get(xPos)!.push({ start: top, end: bottom, paneId: other.tmuxId });
      }
    }
  }

  return { horizontal, vertical };
}

/**
 * Flatten horizontal/vertical maps into a single sorted list of dividers.
 * Canonical sort: orientation (h before v), then axisPos, then start.
 * This ensures stable sequential indices across renders when divider count
 * stays constant (resize, layout cycle, placeholder swap).
 */
function resolveDividers(
  horizontal: Map<number, DividerSegment[]>,
  vertical: Map<number, DividerSegment[]>,
): ResolvedDivider[] {
  const dividers: ResolvedDivider[] = [];

  horizontal.forEach((segments, axisPos) => {
    for (const seg of mergeSegments(segments)) {
      dividers.push({
        orientation: 'h',
        axisPos,
        start: seg.start,
        end: seg.end,
        paneId: seg.paneId,
      });
    }
  });

  vertical.forEach((segments, axisPos) => {
    for (const seg of mergeSegments(segments)) {
      dividers.push({
        orientation: 'v',
        axisPos,
        start: seg.start,
        end: seg.end,
        paneId: seg.paneId,
      });
    }
  });

  // Canonical sort for stable index assignment
  dividers.sort((a, b) => {
    if (a.orientation !== b.orientation) return a.orientation < b.orientation ? -1 : 1;
    if (a.axisPos !== b.axisPos) return a.axisPos - b.axisPos;
    return a.start - b.start;
  });

  return dividers;
}

/** Thickness of resize grab handles in pixels */
const DIVIDER_THICKNESS = 8;

export function ResizeDividers({
  panes,
  charWidth,
  charHeight,
  centeringOffset,
}: ResizeDividersProps) {
  const send = useAppSend();
  const { horizontal, vertical } = collectDividerSegments(panes);
  const dividers = resolveDividers(horizontal, vertical);

  return (
    <>
      {dividers.map((div, idx) => {
        const isH = div.orientation === 'h';
        return (
          <div
            key={`divider-${idx}`}
            className="resize-divider"
            style={
              isH
                ? {
                    cursor: 'ns-resize',
                    left: centeringOffset.x + div.start * charWidth,
                    top: centeringOffset.y + div.axisPos * charHeight - DIVIDER_THICKNESS / 2,
                    width: (div.end - div.start) * charWidth,
                    height: DIVIDER_THICKNESS,
                  }
                : {
                    cursor: 'ew-resize',
                    left:
                      centeringOffset.x +
                      div.axisPos * charWidth +
                      charWidth / 2 -
                      DIVIDER_THICKNESS / 2,
                    top: centeringOffset.y + Math.max(0, div.start - 1) * charHeight,
                    width: DIVIDER_THICKNESS,
                    height: (div.end - Math.max(0, div.start - 1)) * charHeight,
                  }
            }
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              haptics.trigger(10);
              document.addEventListener('mouseup', () => haptics.trigger('success'), {
                once: true,
              });
              send({
                type: 'RESIZE_START',
                paneId: div.paneId,
                handle: isH ? 's' : 'e',
                startX: e.clientX,
                startY: e.clientY,
              });
            }}
          />
        );
      })}
    </>
  );
}
