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
import { layoutDividers } from './dividerLayout';
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
  const dividers = layoutDividers(panes, scope);

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
