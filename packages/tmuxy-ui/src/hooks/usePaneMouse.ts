/**
 * usePaneMouse - Mouse event handler for panes
 *
 * Handles mouse clicks, drags, and wheel events based on pane state:
 * - When mouse_any_flag is true: forward mouse events as SGR sequences to tmux
 * - When mouse_any_flag is false: mouse drag enters client-side copy mode with selection
 * - When alternate_on is true: wheel events send arrow keys
 * - When not in alternate mode: wheel scroll enters client-side copy mode
 * - Shift+click always focuses the pane regardless of mouse mode
 */

import { useCallback, useRef, useState, useEffect } from 'react';
import type { AppMachineEvent } from '../machines/types/events';
import { haptics } from '../utils/haptics';
import { focusKeyboardInput } from '../utils/mobileKeyboard';
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

  // A scrollback view is open at all (either kind): the pane is not following
  // live output, so wheel deltas move the loaded scrollback rather than
  // deciding whether to open it.
  const scrollbackOpen = scrollbackMode !== null;
  // tmux's copy mode specifically: the only place the client drives selection
  // and the cursor. Everywhere else the browser's own selection is the point.
  const copyModeActive = scrollbackMode === 'copy';

  // Track mouse button state for drag events
  const mouseButtonRef = useRef<number | null>(null);

  // Track mouse drag state for copy-mode selection
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingForSelectionRef = useRef(false);
  const lastDragTimeRef = useRef(0);
  // Committed selection start (reactive state for rendering, persists until copy mode exits)
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

  // Auto-scroll state
  const autoScrollTimerRef = useRef<number | null>(null);
  const autoScrollColRef = useRef(0);
  // Document-level mouseup listener ref (for cleanup when mouse released outside pane)
  const documentMouseUpRef = useRef<(() => void) | null>(null);
  // Unmount cleanup: tear down every timer/listener this hook can leave
  // running. A pane can unmount mid-drag (e.g. tmux kills it during a
  // selection), which would otherwise leave the auto-scroll interval firing
  // COPY_MODE_CURSOR_MOVE forever and the document-level mouseup listener
  // calling setSelectionStart on a dead component.
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

  // Clear selection start when copy mode exits
  if (!inMode && !copyModeActive && selectionStart) {
    setSelectionStart(null);
  }

  // Stop auto-scroll timer
  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  // Start auto-scroll in a direction (-1 = up, 1 = down)
  const startAutoScroll = useCallback(
    (direction: -1 | 1, col: number) => {
      autoScrollColRef.current = col;
      if (autoScrollTimerRef.current !== null) return; // already running
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

  // Clean up drag state (shared between handleMouseUp and document mouseup)
  const cleanupDrag = useCallback(() => {
    stopAutoScroll();
    if (isDraggingForSelectionRef.current && dragStartRef.current) {
      setSelectionStart({ ...dragStartRef.current });
    }
    // Releasing a drag in copy mode copies the selection and leaves the mode,
    // as tmux's MouseDragEnd1Pane does; the copied text blinks first. Here, so
    // a release outside the pane (the document listener) copies too.
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

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't handle clicks on the header (drag is handled separately)
      if (target.closest('.pane-header')) return;

      // Focus unconditionally — FOCUS_PANE is a no-op when already active.
      // Mouse-tracking panes (vim/htop) used to forward SGR without focusing,
      // so input stayed routed to the previous pane.
      haptics.trigger(10);
      send({ type: 'FOCUS_PANE', paneId });
      // Browser focus follows: an IME composes only into an editable element.
      // Not on a right-click (or macOS's ctrl-click), though: focusing the
      // input moves the document selection into it, and the context menu is
      // about to ask what was selected. And not where the browser is about to
      // own the drag, for the same reason: focusing here collapsed the page's
      // selection as the drag began, so dragging across text selected nothing.
      // There the keyboard actor hands focus back on release, if the gesture
      // left nothing selected.
      const browserOwnsDrag = !mouseAnyFlag && !copyModeActive;
      if (e.button !== 2 && !e.ctrlKey && !browserOwnsDrag) focusKeyboardInput(paneId);

      // Shift+click: focus only, don't forward or start a drag-selection.
      if (e.shiftKey) {
        return;
      }

      // If mouse tracking is enabled, forward the event
      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        mouseButtonRef.current = e.button;

        // Send SGR mouse press event
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, e.button, cell, false) });
        return;
      }

      // Alternate-screen apps (nvim, less, htop) without mouse tracking: don't
      // start a drag-selection. Our client-side copy mode operates on tmux
      // scrollback, which is hidden while the alternate buffer is active —
      // dragging would pop the user into an unrelated view.
      if (alternateOn) {
        return;
      }

      // Default: prepare for potential drag selection
      mouseButtonRef.current = e.button;

      if (e.button === 0) {
        const cell = pixelToCell(e);
        dragStartRef.current = { x: cell.x, y: Math.max(0, cell.y) };
        lastCellRef.current = null;
        isDraggingForSelectionRef.current = false;

        // Register document-level mouseup so we clean up even if mouse released outside pane
        if (documentMouseUpRef.current) {
          document.removeEventListener('mouseup', documentMouseUpRef.current);
        }
        documentMouseUpRef.current = cleanupDrag;
        document.addEventListener('mouseup', cleanupDrag);
      }
    },
    [send, paneId, mouseAnyFlag, copyModeActive, alternateOn, pixelToCell, cleanupDrag],
  );

  // Handle mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);

        // Send SGR mouse release event (lowercase 'm')
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, mouseButtonRef.current, cell, true) });
        mouseButtonRef.current = null;
        return;
      }

      // Single click (no drag) in copy mode: clear selection and move cursor
      if (!isDraggingForSelectionRef.current && copyModeActive && e.button === 0) {
        const target = e.target as HTMLElement;
        if (!target.closest('.pane-header')) {
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

      // Clean up drag state (also removes document mouseup listener)
      cleanupDrag();
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell, cleanupDrag],
  );

  // Handle mouse move (for drag)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      // Mouse tracking mode: forward SGR drag events
      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        const dragButton = mouseButtonRef.current + 32;
        send({ type: 'DISPATCH_OP', op: mouseOp(paneId, dragButton, cell, false) });
        return;
      }

      // Everywhere but tmux's copy mode the browser owns the drag: returning
      // here (without preventDefault anywhere on the way) is what lets a plain
      // text selection happen, on the live screen and in the scroll view alike.
      if (!copyModeActive) return;

      // Copy mode: drive the client's cell selection.
      if (!dragStartRef.current || mouseButtonRef.current !== 0) return;

      const cell = pixelToCell(e);

      // Throttle drag updates
      const now = Date.now();
      if (now - lastDragTimeRef.current < DRAG_THROTTLE_MS) return;
      lastDragTimeRef.current = now;

      if (!isDraggingForSelectionRef.current) {
        // Check if we've moved at least one cell to start dragging
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

      // Check if mouse is above or below content area for auto-scroll
      const rect = gridRect();
      if (rect && isDraggingForSelectionRef.current) {
        const relY = e.clientY - rect.top;
        const isAbove = relY < 0;
        const isBelow = relY >= rect.height;

        if (isAbove || isBelow) {
          startAutoScroll(isAbove ? -1 : 1, cell.x);
          return; // Don't send another cursor move below
        } else {
          stopAutoScroll();
        }
      }

      // Update cursor position for selection extension
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

  // Handle mouse leave - start auto-scroll if actively dragging, otherwise clean up
  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingForSelectionRef.current) {
        dragStartRef.current = null;
        lastCellRef.current = null;
        mouseButtonRef.current = null;
        return;
      }

      // Start auto-scroll based on which edge the mouse left from
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

  // Accumulate sub-line pixel deltas across wheel events (trackpad support)
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

  // Handle double-click for word selection
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (mouseAnyFlag) return;
      // Skip if this is actually a triple-click (detail >= 3) — handled in handleMouseDown
      if (e.detail >= 3) return;

      // Outside copy mode the browser already selects the word under a
      // double-click, and better than a cell grid can — it knows about word
      // characters in every script.
      if (!copyModeActive) return;

      const cell = pixelToCell(e);
      send({ type: 'COPY_MODE_WORD_SELECT', paneId, row: cell.y, col: cell.x });
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell],
  );

  // Handle triple-click for line selection (detected via click count in mousedown)
  const handleTripleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (mouseAnyFlag) return;

      // Same again: a triple-click selects the line natively. Only copy mode,
      // whose selection is a cell range it has to track itself, needs telling.
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
    /** Selection start cell position for rendering selection overlay */
    selectionStart,
  };
}
