/**
 * A sheet dragged down by its bar (ComposeSheet.tsx): the bar's pointer
 * handlers, how far the sheet is pulled while the finger is on it, and on
 * release either `onClose` or a spring back, as `sheetCloses` decides.
 */

import { useRef, useState, type PointerEvent } from 'react';
import { sheetCloses } from './sheetSwipe';

interface Drag {
  pointerId: number;
  startY: number;
  lastY: number;
  lastAt: number;
  /** Downward speed at the last move, px/ms. */
  speed: number;
}

export function useSheetDrag(onClose: () => void) {
  const [pulled, setPulled] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const end = () => {
    drag.current = null;
    setDragging(false);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    // A press on Cancel or Send is a press, not the start of a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      lastY: e.clientY,
      lastAt: e.timeStamp,
      speed: 0,
    };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const elapsed = e.timeStamp - d.lastAt;
    if (elapsed > 0) d.speed = (e.clientY - d.lastY) / elapsed;
    d.lastY = e.clientY;
    d.lastAt = e.timeStamp;
    setPulled(Math.max(0, e.clientY - d.startY));
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    end();
    const height = sheetRef.current?.getBoundingClientRect().height ?? window.innerHeight;
    if (sheetCloses(Math.max(0, e.clientY - d.startY), d.speed, height)) onClose();
    else setPulled(0);
  };
  const onPointerCancel = () => {
    end();
    setPulled(0);
  };

  return {
    sheetRef,
    pulled,
    dragging,
    barHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
