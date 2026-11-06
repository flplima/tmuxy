/**
 * The drag previews locally and commits `@tmuxy-sidebar-cols` on the column's
 * tmux window only on release, so the pane rewraps once per drag rather than
 * on every move. The width is whole terminal columns (a tmux pane has no
 * sub-cell width), clamped to the bounds the backend enforces.
 */

import { memo, useCallback, useRef, useState } from 'react';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import { selectMeasuredCell, selectSidebarCellMetrics } from '../machines/selectors/layout';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../machines/constants';
import { Tooltip } from './Tooltip';
import type { WindowId } from '../domain/ids';

interface SidebarResizeHandleProps {
  side: 'left' | 'right';
  /** The column's tmux window, which carries the width option. */
  windowId: WindowId | null;
  /** px */
  width: number;
}

export const SidebarResizeHandle = memo(function SidebarResizeHandle({
  side,
  windowId,
  width,
}: SidebarResizeHandleProps) {
  const send = useAppSend();
  const { charWidth: paneCharWidth } = useAppSelector(selectMeasuredCell);
  const dock = useAppSelector(selectSidebarCellMetrics);
  // The dock is sized in its own (smaller) cells; the tree column in pane cells.
  const charWidth = side === 'right' ? dock.cellWidth : paneCharWidth;
  const [dragging, setDragging] = useState(false);
  // Read inside the move/up handlers; lastCols is -1 until the first change.
  const dragRef = useRef({ startX: 0, startWidth: width, lastCols: -1 });

  const colsAt = useCallback(
    (clientX: number) => {
      const d = dragRef.current;
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
    <Tooltip label="Drag to resize · double-click for the default width">
      <div
        className={`sidebar-resize-handle sidebar-resize-handle-${side}${
          dragging ? ' is-dragging' : ''
        }`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${side === 'left' ? 'tree' : 'terminal'} sidebar`}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onDoubleClick={handleReset}
      />
    </Tooltip>
  );
});
