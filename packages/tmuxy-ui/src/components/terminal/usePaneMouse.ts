import { useCallback, useRef, useState, useEffect } from 'react';
import type { AppMachineEvent } from '../../machines/types/events';
import { haptics } from '../../infra/haptics';
import { focusKeyboardInput } from '../../infra/dom/mobileKeyboard';
import {
  AUTO_SCROLL_INTERVAL_MS,
  AUTO_SCROLL_LINES,
  clientToCell,
  DRAG_THROTTLE_MS,
  getGridRect,
  handlePaneWheel,
  mouseOp,
  type UsePaneMouseOptions,
} from './paneMouseHelpers';
import { dot, PANE_HEADER } from '../../infra/dom/terminalDom';

export function usePaneMouse(send: (event: AppMachineEvent) => void, options: UsePaneMouseOptions) {
  const {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag,
    alternateOn,
    inMode,
    scrollbackMode,
    contentRef,
    scrollRef,
    historySize,
    forwardScrollToParent,
  } = options;

  const scrollbackOpen = scrollbackMode !== null;
  // Only tmux's copy mode has a client-driven selection; everywhere else the
  // browser's own selection is the point.
  const copyModeActive = scrollbackMode === 'copy';

  const mouseButtonRef = useRef<number | null>(null);

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingForSelectionRef = useRef(false);
  const lastDragTimeRef = useRef(0);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

  const autoScrollTimerRef = useRef<number | null>(null);
  const autoScrollColRef = useRef(0);
  const documentMouseUpRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const autoScrollTimer = autoScrollTimerRef;
    const documentMouseUp = documentMouseUpRef;
    return () => {
      if (autoScrollTimer.current !== null) {
        clearInterval(autoScrollTimer.current);
        autoScrollTimer.current = null;
      }
      if (documentMouseUp.current) {
        document.removeEventListener('mouseup', documentMouseUp.current);
        documentMouseUp.current = null;
      }
    };
  }, []);

  if (!inMode && !copyModeActive && selectionStart) {
    setSelectionStart(null);
  }

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(
    (direction: -1 | 1, col: number) => {
      autoScrollColRef.current = col;
      if (autoScrollTimerRef.current !== null) return;
      autoScrollTimerRef.current = window.setInterval(() => {
        const targetRow =
          direction < 0 ? -AUTO_SCROLL_LINES : options.paneHeight + AUTO_SCROLL_LINES - 1;
        send({
          type: 'COPY_MODE_CURSOR_MOVE',
          paneId,
          row: targetRow,
          col: autoScrollColRef.current,
          relative: true,
        });
      }, AUTO_SCROLL_INTERVAL_MS);
    },
    [send, paneId, options.paneHeight],
  );

  const cleanupDrag = useCallback(() => {
    stopAutoScroll();
    if (isDraggingForSelectionRef.current && dragStartRef.current) {
      setSelectionStart({ ...dragStartRef.current });
    }
    // Releasing a drag in copy mode copies and leaves the mode, as tmux's
    // MouseDragEnd1Pane binding does.
    if (isDraggingForSelectionRef.current && copyModeActive) {
      send({ type: 'COPY_MODE_MOUSE_COPY', paneId });
    }
    dragStartRef.current = null;
    lastCellRef.current = null;
    isDraggingForSelectionRef.current = false;
    mouseButtonRef.current = null;
    if (documentMouseUpRef.current) {
      document.removeEventListener('mouseup', documentMouseUpRef.current);
      documentMouseUpRef.current = null;
    }
  }, [stopAutoScroll, copyModeActive, send, paneId]);

  const gridRect = useCallback(
    () => getGridRect(scrollRef.current, contentRef.current),
    [contentRef, scrollRef],
  );

  const pixelToCell = useCallback(
    (e: React.MouseEvent): { x: number; y: number } =>
      clientToCell(e, scrollRef.current, contentRef.current, charWidth, charHeight),
    [charWidth, charHeight, contentRef, scrollRef],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(dot(PANE_HEADER))) return;

      haptics.trigger(10);
      send({ type: 'FOCUS_PANE', paneId });
      // Browser focus follows, since an IME composes only into an editable
      // element. Not on a right-click (or macOS's ctrl-click): focusing the
      // input moves the document selection into it, and the context menu is
      // about to ask what was selected. Not where the browser owns the drag
      // either: focusing collapses the page's selection as the drag begins.
      // There the keyboard actor hands focus over on release, if nothing was
      // selected.
      const browserOwnsDrag = !mouseAnyFlag && !copyModeActive;
      if (e.button !== 2 && !e.ctrlKey && !browserOwnsDrag) focusKeyboardInput(paneId);

      // Shift+click focuses only.
      if (e.shiftKey) {
        return;
      }

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        mouseButtonRef.current = e.button;
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, e.button, cell, false) });
        return;
      }

      // The alternate screen hides tmux's scrollback, which is what a
      // drag-selection would select in.
      if (alternateOn) {
        return;
      }

      mouseButtonRef.current = e.button;

      if (e.button === 0) {
        const cell = pixelToCell(e);
        dragStartRef.current = { x: cell.x, y: Math.max(0, cell.y) };
        lastCellRef.current = null;
        isDraggingForSelectionRef.current = false;

        // A release outside the pane still ends the drag.
        if (documentMouseUpRef.current) {
          document.removeEventListener('mouseup', documentMouseUpRef.current);
        }
        documentMouseUpRef.current = cleanupDrag;
        document.addEventListener('mouseup', cleanupDrag);
      }
    },
    [send, paneId, mouseAnyFlag, copyModeActive, alternateOn, pixelToCell, cleanupDrag],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, mouseButtonRef.current, cell, true) });
        mouseButtonRef.current = null;
        return;
      }

      if (!isDraggingForSelectionRef.current && copyModeActive && e.button === 0) {
        const target = e.target as HTMLElement;
        if (!target.closest(dot(PANE_HEADER))) {
          const cell = pixelToCell(e);
          send({ type: 'COPY_MODE_SELECTION_CLEAR', paneId });
          send({
            type: 'COPY_MODE_CURSOR_MOVE',
            paneId,
            row: Math.max(0, cell.y),
            col: cell.x,
            relative: true,
          });
        }
      }

      cleanupDrag();
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell, cleanupDrag],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        // SGR motion: the button code plus 32.
        const dragButton = mouseButtonRef.current + 32;
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, dragButton, cell, false) });
        return;
      }

      // Everywhere but tmux's copy mode the browser owns the drag: no
      // preventDefault on the way is what lets its text selection happen.
      if (!copyModeActive) return;

      if (!dragStartRef.current || mouseButtonRef.current !== 0) return;

      const cell = pixelToCell(e);

      const now = Date.now();
      if (now - lastDragTimeRef.current < DRAG_THROTTLE_MS) return;
      lastDragTimeRef.current = now;

      if (!isDraggingForSelectionRef.current) {
        const dx = Math.abs(cell.x - dragStartRef.current.x);
        const dy = Math.abs(cell.y - dragStartRef.current.y);
        if (dx === 0 && dy === 0) return;

        isDraggingForSelectionRef.current = true;
        const start = dragStartRef.current;

        send({
          type: 'COPY_MODE_SELECTION_START',
          paneId,
          mode: 'char',
          row: start.y,
          col: start.x,
        });
        lastCellRef.current = { ...start };
      }

      const rect = gridRect();
      if (rect && isDraggingForSelectionRef.current) {
        const relY = e.clientY - rect.top;
        const isAbove = relY < 0;
        const isBelow = relY >= rect.height;

        if (isAbove || isBelow) {
          startAutoScroll(isAbove ? -1 : 1, cell.x);
          return;
        } else {
          stopAutoScroll();
        }
      }

      if (lastCellRef.current) {
        const clampedRow = Math.max(0, Math.min(cell.y, options.paneHeight - 1));
        send({
          type: 'COPY_MODE_CURSOR_MOVE',
          paneId,
          row: clampedRow,
          col: cell.x,
          relative: true,
        });
        lastCellRef.current = cell;
      }
    },
    [
      send,
      paneId,
      mouseAnyFlag,
      copyModeActive,
      pixelToCell,
      gridRect,
      options.paneHeight,
      startAutoScroll,
      stopAutoScroll,
    ],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingForSelectionRef.current) {
        dragStartRef.current = null;
        lastCellRef.current = null;
        mouseButtonRef.current = null;
        return;
      }

      const rect = gridRect();
      if (rect) {
        const relY = e.clientY - rect.top;
        const col = Math.max(0, Math.floor((e.clientX - rect.left) / charWidth));
        if (relY >= rect.height) {
          startAutoScroll(1, col);
        } else if (relY < 0) {
          startAutoScroll(-1, col);
        }
      }
    },
    [gridRect, charWidth, startAutoScroll],
  );

  // A trackpad's wheel deltas are sub-line pixels.
  const wheelRemainder = useRef(0);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      handlePaneWheel(e, {
        send,
        paneId,
        charHeight,
        alternateOn,
        mouseAnyFlag,
        scrollbackOpen,
        inMode,
        pixelToCell,
        scrollEl: scrollRef.current,
        historySize,
        forwardScrollToParent,
        wheelRemainder,
      });
    },
    [
      send,
      paneId,
      charHeight,
      alternateOn,
      mouseAnyFlag,
      scrollbackOpen,
      inMode,
      pixelToCell,
      scrollRef,
      historySize,
      forwardScrollToParent,
    ],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(dot(PANE_HEADER))) return;
      if (mouseAnyFlag) return;
      // A triple-click is handleTripleClick's, called from TerminalPane's mousedown.
      if (e.detail >= 3) return;

      // Outside copy mode the browser selects the word itself, and knows the
      // word characters of every script.
      if (!copyModeActive) return;

      const cell = pixelToCell(e);
      send({ type: 'COPY_MODE_WORD_SELECT', paneId, row: cell.y, col: cell.x });
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell],
  );

  const handleTripleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(dot(PANE_HEADER))) return;
      if (mouseAnyFlag) return;

      // Outside copy mode the browser selects the line itself.
      if (!copyModeActive) return;

      e.preventDefault();
      const cell = pixelToCell(e);
      send({ type: 'COPY_MODE_LINE_SELECT', paneId, row: cell.y });
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell],
  );

  return {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    handleDoubleClick,
    handleTripleClick,
    selectionStart,
  };
}
