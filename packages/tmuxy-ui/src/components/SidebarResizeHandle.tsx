/**
 * SidebarResizeHandle — the drag strip on a sidebar column's inner edge.
 *
 * Dragging commits a new column width as `@tmuxy-sidebar-cols` on that column's
 * tmux window, which is what makes the resize real rather than cosmetic: the
 * backend sizes the column's PANE to the same number (`sidebar_dock::cols`), so
 * the content rewraps to the width being drawn, the width survives a reload, and
 * another client attached to the same session sees the column move too.
 *
 * The width is therefore quantised to whole terminal columns — there is no
 * sub-cell width a tmux pane could have — and clamped to the same bounds the
 * backend enforces, so the preview can never promise a size the pane won't take.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useAppSend, useAppSelector, selectCharSize } from '../machines/AppContext';
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
  const { charWidth } = useAppSelector(selectCharSize);
  const [dragging, setDragging] = useState(false);
  // Read inside the move/up listeners, which are installed once per drag.
  const dragRef = useRef({ startX: 0, startWidth: width, charWidth, side, windowId, send });
  dragRef.current = { ...dragRef.current, charWidth, side, windowId, send };

  const handleDown = useCallback(
    (e: React.MouseEvent) => {
      if (!windowId) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.startX = e.clientX;
      dragRef.current.startWidth = width;
      setDragging(true);
    },
    [windowId, width],
  );

  useEffect(() => {
    if (!dragging) return;

    const colsAt = (clientX: number) => {
      const d = dragRef.current;
      // The left column grows rightwards, the right column leftwards.
      const delta = d.side === 'left' ? clientX - d.startX : d.startX - clientX;
      const px = d.startWidth + delta;
      const cols = Math.round(px / (d.charWidth || 1));
      return Math.min(SIDEBAR_MAX_COLS, Math.max(SIDEBAR_MIN_COLS, cols));
    };

    // The width is whole columns, so most of a drag's mousemoves resolve to the
    // width already set. Only a real change is worth a tmux round trip.
    let lastCols = -1;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d.windowId) return;
      const cols = colsAt(e.clientX);
      if (cols === lastCols) return;
      lastCols = cols;
      // Committed live rather than on mouseup: the pane has to rewrap as the
      // column moves, or the terminal inside lags the edge being dragged.
      d.send({
        type: 'SEND_TMUX_COMMAND',
        command: `set-option -w -t ${d.windowId} @tmuxy-sidebar-cols ${cols}`,
      });
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  if (!windowId) return null;

  return (
    <div
      className={`sidebar-resize-handle sidebar-resize-handle-${side}${
        dragging ? ' is-dragging' : ''
      }`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${side === 'left' ? 'tree' : 'terminal'} sidebar`}
      title="Drag to resize"
      onMouseDown={handleDown}
    />
  );
});
