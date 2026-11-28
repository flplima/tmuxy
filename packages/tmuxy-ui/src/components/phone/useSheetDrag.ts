/**
 * A sheet pulled down (ComposeSheet.tsx): how far it is pulled while the
 * finger is on it, and on release either `onClose` or a spring back, as
 * `sheetCloses` decides. Two places start a pull: the bar, by its pointer
 * handlers here, and the text box while its text is at the top
 * (useSheetScroll.ts), through `pull`.
 */

import { useRef, useState, type PointerEvent } from 'react';
import { sheetCloses } from '../../domain/sheetSwipe';

interface Drag {
  id: number;
  startY: number;
  lastY: number;
  lastAt: number;
  /** Downward speed at the last move, px/ms. */
  speed: number;
}

/** A pull by one finger (`id`), at `y` px down the screen at `at` ms. */
export interface SheetPull {
  begin: (id: number, y: number, at: number) => void;
  move: (id: number, y: number, at: number) => void;
  release: (id: number, y: number) => void;
  cancel: () => void;
}

export function useSheetDrag(onClose: () => void) {
  const [pulled, setPulled] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const pull: SheetPull = {
    begin: (id, y, at) => {
      drag.current = { id, startY: y, lastY: y, lastAt: at, speed: 0 };
      setDragging(true);
    },
    move: (id, y, at) => {
      const d = drag.current;
      if (!d || d.id !== id) return;
      if (at > d.lastAt) d.speed = (y - d.lastY) / (at - d.lastAt);
      d.lastY = y;
      d.lastAt = at;
      setPulled(Math.max(0, y - d.startY));
    },
    release: (id, y) => {
      const d = drag.current;
      if (!d || d.id !== id) return;
      drag.current = null;
      setDragging(false);
      const height = sheetRef.current?.getBoundingClientRect().height ?? window.innerHeight;
      if (sheetCloses(Math.max(0, y - d.startY), d.speed, height)) onClose();
      else setPulled(0);
    },
    cancel: () => {
      drag.current = null;
      setDragging(false);
      setPulled(0);
    },
  };

  const barHandlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      // A press on × is a press, not the start of a drag.
      if ((e.target as HTMLElement).closest('button')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pull.begin(e.pointerId, e.clientY, e.timeStamp);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => pull.move(e.pointerId, e.clientY, e.timeStamp),
    onPointerUp: (e: PointerEvent<HTMLElement>) => pull.release(e.pointerId, e.clientY),
    onPointerCancel: () => pull.cancel(),
  };

  return { sheetRef, pulled, dragging, pull, barHandlers };
}
