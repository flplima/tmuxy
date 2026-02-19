/**
 * ResizeDividers - Renders resize handles between adjacent panes.
 *
 * Scans pane pairs to find shared edges (with 1-cell tmux divider gap),
 * merges overlapping segments, and renders invisible clickable dividers.
 */

import React from 'react';
import { useAppSend } from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';

interface ResizeDividersProps {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  centeringOffset: { x: number; y: number };
}

interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number;   // right for horizontal, bottom for vertical
  paneId: string; // pane to resize
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

      // Horizontal divider: panes share a horizontal edge (with 1-cell tmux divider gap)
      const horizontallyOverlap = pane.x < other.x + other.width && pane.x + pane.width > other.x;

      if (pane.y + pane.height + 1 === other.y && horizontallyOverlap) {
        const yPos = pane.y + pane.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);
        if (!horizontal.has(yPos)) horizontal.set(yPos, []);
        horizontal.get(yPos)!.push({ start: left, end: right, paneId: pane.tmuxId });
      } else if (other.y + other.height + 1 === pane.y && horizontallyOverlap) {
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

export function ResizeDividers({ panes, charWidth, charHeight, centeringOffset }: ResizeDividersProps) {
  const send = useAppSend();
  const { horizontal, vertical } = collectDividerSegments(panes);
  const dividerElements: React.ReactElement[] = [];

  // Horizontal dividers (between vertically stacked panes)
  // Positioned at the header row (pane.y - 1) since headers use divider rows
  horizontal.forEach((segments, yPos) => {
    const merged = mergeSegments(segments);
    merged.forEach((seg, idx) => {
      dividerElements.push(
        <div
          key={`h-${yPos}-${idx}`}
          className="resize-divider resize-divider-h"
          style={{
            left: centeringOffset.x + seg.start * charWidth,
            top: centeringOffset.y + yPos * charHeight,
            width: (seg.end - seg.start) * charWidth,
            height: charHeight,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            send({
              type: 'RESIZE_START',
              paneId: seg.paneId,
              handle: 's',
              startX: e.clientX,
              startY: e.clientY,
            });
          }}
        />
      );
    });
  });

  // Vertical dividers (between horizontally adjacent panes)
  vertical.forEach((segments, xPos) => {
    const merged = mergeSegments(segments);
    merged.forEach((seg, idx) => {
      const headerY = Math.max(0, seg.start - 1);
      dividerElements.push(
        <div
          key={`v-${xPos}-${idx}`}
          className="resize-divider resize-divider-v"
          style={{
            left: centeringOffset.x + xPos * charWidth,
            top: centeringOffset.y + headerY * charHeight,
            width: charWidth,
            height: (seg.end - headerY) * charHeight,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            send({
              type: 'RESIZE_START',
              paneId: seg.paneId,
              handle: 'e',
              startX: e.clientX,
              startY: e.clientY,
            });
          }}
        />
      );
    });
  });

  return <>{dividerElements}</>;
}
