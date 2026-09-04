/**
 * SidebarResizeHandle — the drag strip on a sidebar column's inner edge.
 *
 * While the pointer is down the column follows it immediately: every change of
 * a whole column raises SIDEBAR_RESIZE_PREVIEW, which `selectSidebarLayout`
 * draws ahead of the server. On release the width is committed as
 * `@tmuxy-sidebar-cols` on the column's tmux window (SIDEBAR_RESIZE_COMMIT):
 * the backend sizes the column's PANE to the same number, so the content
 * rewraps to the width being drawn, the width survives a reload, and another
 * client attached to the same session sees the column move too. Committing on
 * release rather than on every move keeps the pane from rewrapping a dozen
 * times per drag.
 *
 * The width is quantised to whole terminal columns — there is no sub-cell
 * width a tmux pane could have — and clamped to the same bounds the backend
 * enforces, so the preview can never promise a size the pane won't take.
 *
 * Pointer events, not mouse events, so a finger or pen drags it too; a
 * double-click puts the column back to its default width.
 */

import { memo, useCallback, useRef, useState } from 'react';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectSidebarCellMetrics,
} from '../machines/AppContext';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../machines/constants';

interface SidebarResizeHandleProps {
  side: 'left' | 'right';
  /** The column's tmux window, which carries the width option. */
  windowId: string | null;
  /** Current column width in pixels, the drag's starting point. */
  width: number;
}

export const SidebarResizeHandle = memo(function SidebarResizeHandle({
  side,
  windowId,
  width,
}: SidebarResizeHandleProps) {
  const send = useAppSend();
  const { charWidth: paneCharWidth } = useAppSelector(selectCharSize);
  const dock = useAppSelector(selectSidebarCellMetrics);
  // The dock is sized in its own (smaller) cells; the tree column in pane cells.
  const charWidth = side === 'right' ? dock.cellWidth : paneCharWidth;
  const [dragging, setDragging] = useState(false);
  // Read inside the move/up handlers; lastCols is -1 until the first change.
  const dragRef = useRef({ startX: 0, startWidth: width, lastCols: -1 });

  const colsAt = useCallback(
    (clientX: number) => {
      const d = dragRef.current;
      // The left column grows rightwards, the right column leftwards.
      const delta = side === 'left' ? clientX - d.startX : d.startX - clientX;
      const cols = Math.round((d.startWidth + delta) / (charWidth || 1));
      return Math.min(SIDEBAR_MAX_COLS, Math.max(SIDEBAR_MIN_COLS, cols));
    },
    [side, charWidth],
  );

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!windowId || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width, lastCols: -1 };
      setDragging(true);
    },
    [windowId, width],
  );

  const handleMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const cols = colsAt(e.clientX);
      // Most moves resolve to the column already drawn; only a change is news.
      if (cols === dragRef.current.lastCols) return;
      dragRef.current.lastCols = cols;
      send({ type: 'SIDEBAR_RESIZE_PREVIEW', side, cols });
    },
    [dragging, colsAt, send, side],
  );

  const handleUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const cols = dragRef.current.lastCols;
      // A press with no movement previewed nothing, so there is nothing to write.
      if (cols >= 0) send({ type: 'SIDEBAR_RESIZE_COMMIT', side, cols });
    },
    [dragging, send, side],
  );

  const handleReset = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'SIDEBAR_RESIZE_COMMIT', side, cols: null });
    },
    [send, side],
  );

  if (!windowId) return null;

  return (
    <div
      className={`sidebar-resize-handle sidebar-resize-handle-${side}${
        dragging ? ' is-dragging' : ''
      }`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${side === 'left' ? 'tree' : 'terminal'} sidebar`}
      title="Drag to resize · double-click for the default width"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onDoubleClick={handleReset}
    />
  );
});
