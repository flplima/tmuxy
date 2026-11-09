/**
 * Where a window's resize dividers are, from its panes and its split tree:
 * the pure half of components/ResizeDividers.tsx, which draws them.
 *
 * A divider is the 1-cell gap between two panes, gathered per line and
 * merged where the segments on it move together. tmux's tree says which do;
 * a split's placeholder (domain/ids.ts) is not in it yet, so its segment
 * goes with whatever it meets: it lies inside the box of the pane it was
 * split from, and borders that pane's line. Left apart, the line beside a
 * split column was drawn as two dividers until tmux confirmed the split and
 * became one again, a divider node added and removed within the split.
 */

import type { PaneCellBox } from '../machines/types/domain';
import type { TmuxPane } from '../domain/client';
import { isPlaceholderId, type PaneId } from '../domain/ids';

interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number; // right for horizontal, bottom for vertical
  paneId: PaneId;
}

export interface ResolvedDivider {
  orientation: 'h' | 'v';
  axisPos: number; // yPos for horizontal, xPos for vertical
  start: number;
  end: number;
  paneId: PaneId;
}

/**
 * Two segments on one line are still two dividers when tmux resizes them
 * apart — the row lines of an even 2×2 grid whose root splits into columns.
 */
function mergeSegments(
  segments: DividerSegment[],
  sameDivider: (a: DividerSegment, b: DividerSegment) => boolean,
): DividerSegment[] {
  if (segments.length <= 1) return segments;

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: DividerSegment[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // tmux's divider is a 1-cell gap
    if (next.start <= current.end + 1 && sameDivider(current, next)) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}

function collectDividerSegments(panes: TmuxPane[]) {
  const horizontal = new Map<number, DividerSegment[]>();
  const vertical = new Map<number, DividerSegment[]>();

  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];

    for (let j = i + 1; j < panes.length; j++) {
      const other = panes[j];

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

function resolveDividers(
  horizontal: Map<number, DividerSegment[]>,
  vertical: Map<number, DividerSegment[]>,
  scope: (paneId: PaneId, handle: 's' | 'e') => Record<PaneId, PaneCellBox>,
): ResolvedDivider[] {
  const dividers: ResolvedDivider[] = [];
  const movedTogether = (handle: 's' | 'e') => (a: DividerSegment, b: DividerSegment) =>
    isPlaceholderId(a.paneId) || isPlaceholderId(b.paneId) || b.paneId in scope(a.paneId, handle);

  horizontal.forEach((segments, axisPos) => {
    for (const seg of mergeSegments(segments, movedTogether('s'))) {
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
    for (const seg of mergeSegments(segments, movedTogether('e'))) {
      dividers.push({
        orientation: 'v',
        axisPos,
        start: seg.start,
        end: seg.end,
        paneId: seg.paneId,
      });
    }
  });

  dividers.sort((a, b) => {
    if (a.orientation !== b.orientation) return a.orientation < b.orientation ? -1 : 1;
    if (a.axisPos !== b.axisPos) return a.axisPos - b.axisPos;
    return a.start - b.start;
  });

  return dividers;
}

/**
 * The dividers of `panes`, sorted so that a divider keeps its index (its
 * React key) while the layout only moves.
 */
export function layoutDividers(
  panes: TmuxPane[],
  scope: (paneId: PaneId, handle: 's' | 'e') => Record<PaneId, PaneCellBox>,
): ResolvedDivider[] {
  const { horizontal, vertical } = collectDividerSegments(panes);
  return resolveDividers(horizontal, vertical, scope);
}
