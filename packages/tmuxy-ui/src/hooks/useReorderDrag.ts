/**
 * useReorderDrag — the press-and-drag that reorders tabs, shared by the tab
 * strip (WindowTabs) and the Tab Overview's card grid.
 *
 * A press captures the pointer and remembers where it began. A mouse turns the
 * press into a drag after a few pixels of travel; a finger after a long press,
 * and a finger that moves first is scrolling, so the press is dropped. While a
 * drag is active the card follows the pointer (`dx`/`dy`) and the index it
 * would land at is re-read from the OTHER cards' centres on every move. The
 * release reports the drop to the caller and returns the press, so the caller
 * can tell a drag that ended from a click that never became one.
 *
 * The drag is transient pointer state and stays here; the reorder itself is
 * the caller's event.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS, capturePointer, dropIndex } from '../utils/tabOverview';
import type { WindowId } from '../domain/ids';

export interface ReorderDragState {
  windowId: WindowId;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** Current pointer offset from the press, for the dragged card's transform. */
  dx: number;
  dy: number;
  /** Where the card would land, as an index among the OTHER cards. */
  overIndex: number;
  /** True once the threshold / long-press turned the press into a drag. */
  active: boolean;
}

interface UseReorderDragOptions {
  /** The element holding the cards; the drop index is read from its cards' centres. */
  containerRef: RefObject<HTMLElement | null>;
  /** Selects the cards inside the container; each carries `data-window-id`. */
  cardSelector: string;
  /**
   * `x` for cards on one row (only horizontal position decides where a card
   * lands); `xy` for a wrapped grid, where the nearest row is picked first.
   */
  axis: 'x' | 'xy';
  /** A viewer may press (and so click), but a press never becomes a drag. */
  readOnly: boolean;
  /** An active drag ended somewhere other than where it began. */
  onReorder: (windowId: WindowId, toIndex: number) => void;
}

export function useReorderDrag({
  containerRef,
  cardSelector,
  axis,
  readOnly,
  onReorder,
}: UseReorderDragOptions) {
  const [drag, setDrag] = useState<ReorderDragState | null>(null);
  const longPressRef = useRef<number | null>(null);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const centersExcluding = (windowId: WindowId) =>
    Array.from(containerRef.current?.querySelectorAll<HTMLElement>(cardSelector) ?? [])
      .filter((c) => c.dataset.windowId !== windowId)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: axis === 'xy' ? r.top + r.height / 2 : 0 };
      });

  /**
   * Begin a press on the card at `index`. The caller has already decided the
   * press is one that may drag (not a button, not a right-click…).
   */
  const handlePointerDown = (
    e: ReactPointerEvent<HTMLElement>,
    windowId: WindowId,
    index: number,
  ) => {
    capturePointer(e.currentTarget, e.pointerId);
    const state: ReorderDragState = {
      windowId,
      fromIndex: index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      overIndex: index,
      active: false,
    };
    setDrag(state);
    if (e.pointerType === 'touch' && !readOnly) {
      clearLongPress();
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = null;
        setDrag((d) => (d && d.windowId === state.windowId ? { ...d, active: true } : d));
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag || readOnly || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let active = drag.active;
    if (!active) {
      if (e.pointerType === 'touch') {
        // A finger that moves before the long press fires is scrolling.
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX * 2) {
          clearLongPress();
          setDrag(null);
        }
        return;
      }
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active = true;
    }
    const overIndex = dropIndex(centersExcluding(drag.windowId), {
      x: e.clientX,
      y: axis === 'xy' ? e.clientY : 0,
    });
    setDrag({ ...drag, dx, dy, overIndex, active });
  };

  /**
   * End the press. Returns it as it was — `active` says whether it had become
   * a drag — or null when the pointer was not the one pressed.
   */
  const handlePointerUp = (e: ReactPointerEvent<HTMLElement>): ReorderDragState | null => {
    clearLongPress();
    if (!drag || e.pointerId !== drag.pointerId) return null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
    if (drag.active && drag.overIndex !== drag.fromIndex) {
      onReorder(drag.windowId, drag.overIndex);
    }
    return drag;
  };

  const handlePointerCancel = () => {
    clearLongPress();
    setDrag(null);
  };

  /** The drag in progress, once the press has become one. */
  const dragging = drag?.active ? drag : null;
  /**
   * Strip index of the card the dragged one would be inserted before; equal
   * to the card count when it would land at the end, -1 with no drag.
   */
  const dropMarkerAt = dragging
    ? dragging.overIndex >= dragging.fromIndex
      ? dragging.overIndex + 1
      : dragging.overIndex
    : -1;

  return {
    dragging,
    dropMarkerAt,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}
