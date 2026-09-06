/**
 * WindowTabs - the tmux window tabs in the status bar.
 *
 * Tabs sit left-aligned at their natural width, each with a close button on its
 * right, so the rest of the strip stays empty — and on the desktop that empty
 * header is what drags the OS window (see StatusBar). A lone tab sits in that
 * same left-aligned position with the `+` directly after it, but carries no
 * close button, takes no hover background, and is itself a drag handle for the
 * window: with nothing to switch to, it is a label on the window rather than a
 * control.
 *
 * The active tab is marked by BRIGHTNESS alone — full opacity and pure white
 * against the others' dimmed grey — with no pill or background behind it.
 *
 * A press selects; a press that travels (a mouse after a few pixels, a finger
 * after a long press) drags the tab along the strip and drops it at a new
 * position, reordering tmux's windows the way the Tab Overview does. The drag
 * is transient pointer state and stays here.
 *
 * Right-click opens a context menu with tab operations.
 */

import { memo, useMemo, useCallback, useRef, useState } from 'react';
import { useAppSend, useAppSelectorShallow, selectVisibleWindows } from '../machines/AppContext';
import { TabContextMenu } from './TabContextMenu';
import { haptics } from '../utils/haptics';
import { LogProfiler } from '../utils/renderLog';
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS, capturePointer, dropIndex } from '../utils/tabOverview';
import type { TmuxWindow } from '../machines/types';

interface TabContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  windowId: string;
}

interface DragState {
  windowId: string;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** Current horizontal pointer offset from the press, for the tab's transform. */
  dx: number;
  /** Index among the OTHER tabs the dragged one would be inserted at. */
  overIndex: number;
  /** True once the threshold / long-press turned the press into a drag. */
  active: boolean;
}

/**
 * Memoized (no props): context.windows gets a fresh array identity on every
 * model tick; the shallow selectors below keep re-renders to actual window
 * changes, and the memo shields against parent re-renders.
 */
export const WindowTabs = memo(function WindowTabs() {
  const send = useAppSend();
  const rawWindows = useAppSelectorShallow(selectVisibleWindows);
  const listRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    windowId: '',
  });

  // Dedup safety net: ensure no duplicate window IDs reach the DOM
  const visibleWindows = useMemo(
    () => [...new Map(rawWindows.map((w) => [w.id, w])).values()],
    [rawWindows],
  );

  // Closes the tab whose button was pressed, not the current window.
  const handleCloseWindow = useCallback(
    (e: React.MouseEvent, window: TmuxWindow) => {
      e.preventDefault();
      e.stopPropagation();
      haptics.trigger(10);
      send({ type: 'CLOSE_TAB', windowId: window.id });
    },
    [send],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, windowId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, windowId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const isSingleTab = visibleWindows.length === 1;

  // ---- pointer: press to select, drag to reorder ---------------------------
  // The strip is one row, so only the x axis decides where a tab lands.
  const centersExcluding = (windowId: string) =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('.tab-name[data-window-id]') ?? [])
      .filter((t) => t.dataset.windowId !== windowId)
      .map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: 0 };
      });

  const clearLongPress = () => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLSpanElement>, index: number) => {
    const tab = visibleWindows[index];
    // A lone tab is the desktop window's drag handle, not a control.
    if (!tab || isSingleTab || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    capturePointer(e.currentTarget, e.pointerId);
    const state: DragState = {
      windowId: tab.id,
      fromIndex: index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      overIndex: index,
      active: false,
    };
    setDrag(state);
    if (e.pointerType === 'touch') {
      clearLongPress();
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = null;
        setDrag((d) => (d && d.windowId === state.windowId ? { ...d, active: true } : d));
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let active = drag.active;
    if (!active) {
      if (e.pointerType === 'touch') {
        // A finger that moves before the long press fires is scrolling the strip.
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX * 2) {
          clearLongPress();
          setDrag(null);
        }
        return;
      }
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active = true;
    }
    const overIndex = dropIndex(centersExcluding(drag.windowId), { x: e.clientX, y: 0 });
    setDrag({ ...drag, dx, overIndex, active });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLSpanElement>, window: TmuxWindow) => {
    clearLongPress();
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const d = drag;
    setDrag(null);
    if (d.active) {
      if (d.overIndex !== d.fromIndex) {
        haptics.trigger(10);
        send({ type: 'REORDER_TAB', windowId: d.windowId, toIndex: d.overIndex });
      }
      return;
    }
    // A press that never became a drag selects the tab.
    haptics.trigger(10);
    send({ type: 'SELECT_TAB', windowId: window.id });
  };

  const handlePointerCancel = () => {
    clearLongPress();
    setDrag(null);
  };

  const dragging = drag?.active ? drag : null;
  // Strip index of the tab the dragged one would be inserted before; equal to
  // the tab count when it would land at the end.
  const dropMarkerAt = dragging
    ? dragging.overIndex >= dragging.fromIndex
      ? dragging.overIndex + 1
      : dragging.overIndex
    : -1;

  return (
    <LogProfiler id="WindowTabs">
      <div ref={listRef} className={`tab-list${isSingleTab ? ' tab-list-single' : ''}`}>
        {visibleWindows.map((window, idx) => {
          const visualIndex = idx + 1;
          const isDragged = dragging?.windowId === window.id;
          const className = [
            'tab-name',
            window.active ? 'tab-name-active' : '',
            isDragged ? 'is-dragging' : '',
            dropMarkerAt === idx ? 'is-drop-before' : '',
            dropMarkerAt === visibleWindows.length && idx === visibleWindows.length - 1
              ? 'is-drop-after'
              : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <span
              key={window.id}
              data-window-id={window.id}
              className={className}
              style={isDragged ? { transform: `translateX(${dragging!.dx}px)` } : undefined}
              onPointerDown={(e) => handlePointerDown(e, idx)}
              onPointerMove={handlePointerMove}
              onPointerUp={(e) => handlePointerUp(e, window)}
              onPointerCancel={handlePointerCancel}
              onContextMenu={(e) => handleContextMenu(e, window.id)}
              role="tab"
              aria-selected={window.active}
              aria-label={`Tab ${visualIndex}: ${window.name}${window.active ? ' (active)' : ''}`}
            >
              <span className="tab-name-label">
                {visualIndex}:{window.name || `Tab ${visualIndex}`}
              </span>
              {!isSingleTab && (
                <button
                  type="button"
                  className="tab-close"
                  onClick={(e) => handleCloseWindow(e, window)}
                  title="Close tab"
                  aria-label={`Close tab ${visualIndex}`}
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
        {contextMenu.visible && (
          <TabContextMenu
            windowId={contextMenu.windowId}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={closeContextMenu}
          />
        )}
      </div>
    </LogProfiler>
  );
});
