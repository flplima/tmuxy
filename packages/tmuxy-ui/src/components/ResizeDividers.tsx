/**
 * A divider whose panes have no room to give — a stack of one-row panes, say —
 * is drawn as pinned and refuses the drag, rather than accepting a gesture
 * tmux would throw away.
 *
 * Keys are indices in a canonical sort order, so React reuses the DOM nodes
 * across resize, layout cycle and placeholder swap: a tmux layout of N panes
 * has N-1 dividers, so the keys stay put when only positions change.
 */

import { useAppSend } from '../machines/appHooks';
import { dividerBox } from '../domain/paneGeometry';
import type { PaneCellBox } from '../machines/types/domain';
import type { TmuxPane } from '../domain/client';
import { haptics } from '../infra/haptics';
import { bandScope, resizeLimits, isLocked } from '../machines/resize/limits';
import type { PaneId } from '../domain/ids';
import type { PaneTree } from '../domain/wire';

interface ResizeDividersProps {
  panes: TmuxPane[];
  /** The window's split structure: which dividers are one, and what each drag moves. */
  paneTree: PaneTree | null;
  charWidth: number;
  charHeight: number;
  centeringOffset: { x: number; y: number };
}

interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number; // right for horizontal, bottom for vertical
  paneId: PaneId;
}

interface ResolvedDivider {
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
    b.paneId in scope(a.paneId, handle);

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

/** px */
const DIVIDER_THICKNESS = 8;

export function ResizeDividers({
  panes,
  paneTree,
  charWidth,
  charHeight,
  centeringOffset,
}: ResizeDividersProps) {
  const send = useAppSend();
  const geometry: Record<PaneId, PaneCellBox> = Object.fromEntries(
    panes.map((p) => [p.tmuxId, { x: p.x, y: p.y, width: p.width, height: p.height }]),
  );
  const scope = (paneId: PaneId, handle: 's' | 'e') =>
    bandScope(geometry, paneTree, paneId, handle);
  const { horizontal, vertical } = collectDividerSegments(panes);
  const dividers = resolveDividers(horizontal, vertical, scope);

  return (
    <>
      {dividers.map((div, idx) => {
        const isH = div.orientation === 'h';
        const handle = isH ? 's' : 'e';
        const locked = isLocked(resizeLimits(scope(div.paneId, handle), div.paneId, handle));
        return (
          <div
            key={`divider-${idx}`}
            className={`resize-divider${locked ? ' resize-divider-locked' : ''}`}
            data-testid={`resize-divider-${idx}`}
            aria-disabled={locked || undefined}
            style={{
              cursor: locked ? 'not-allowed' : isH ? 'ns-resize' : 'ew-resize',
              ...dividerBox(div, charWidth, charHeight, centeringOffset, DIVIDER_THICKNESS),
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (locked) return;
              haptics.trigger(10);
              document.addEventListener('mouseup', () => haptics.trigger('success'), {
                once: true,
              });
              send({
                type: 'RESIZE_START',
                paneId: div.paneId,
                handle,
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
