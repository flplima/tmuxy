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

import { useCallback, useRef, useState, useEffect, type RefObject } from 'react';
import type { AppMachineEvent } from '../machines/types';
import type { ScrollbackMode } from '../tmux/types';
import { sendScrollLines, sgrMouseCommand } from './scrollUtils';
import { haptics } from '../utils/haptics';
import { focusKeyboardInput } from '../utils/mobileKeyboard';

interface UsePaneMouseOptions {
  paneId: string;
  /** Character width in pixels */
  charWidth: number;
  /** Character height in pixels */
  charHeight: number;
  /** Whether the application wants mouse events */
  mouseAnyFlag: boolean;
  /** Whether the application is in alternate screen mode */
  alternateOn: boolean;
  /** Whether the pane is in copy mode */
  inMode: boolean;
  /**
   * Which scrollback view the pane is showing, or null for the live screen.
   *
   * Only `copy` drives the client's cell selection from here. On the live
   * screen and in the scroll view the browser owns selecting — this hook must
   * keep its hands off the event so the native selection can happen, which is
   * what makes dragging feel like any other terminal.
   */
  scrollbackMode: ScrollbackMode | null;
  /** Pane height in rows (for scroll calculations) */
  paneHeight: number;
  /** Ref to the .pane-content element (used for coordinate calculation) */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Ref to the scroll container (proxy target for wheel events) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Number of scrollback lines above the visible terminal */
  historySize: number;
  /** When true, wheel events bubble to parent when there's nothing to scroll */
  forwardScrollToParent?: boolean;
}

/** Minimum time between drag updates (ms) */
const DRAG_THROTTLE_MS = 30;

/** Auto-scroll interval (ms) */
const AUTO_SCROLL_INTERVAL_MS = 50;

/** Auto-scroll speed (lines per tick) */
const AUTO_SCROLL_LINES = 2;

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
    dragStartRef.current = null;
    lastCellRef.current = null;
    isDraggingForSelectionRef.current = false;
    mouseButtonRef.current = null;
    if (documentMouseUpRef.current) {
      document.removeEventListener('mouseup', documentMouseUpRef.current);
      documentMouseUpRef.current = null;
    }
  }, [stopAutoScroll]);

  // Convert pixel coordinates to terminal cell coordinates
  // Uses the .pane-content element's rect so coordinates are relative to the
  // terminal content area (below the header), not the entire pane wrapper.
  // Accounts for sub-line scroll offset when the scroll container is not
  // line-aligned (smooth scroll leaves fractional pixel offsets).
  // Does NOT clamp Y so we can detect above/below for auto-scroll.
  const pixelToCell = useCallback(
    (e: React.MouseEvent): { x: number; y: number } => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const relX = e.clientX - rect.left;
      let relY = e.clientY - rect.top;
      // When the scroll container has a sub-line offset (scrollTop not aligned
      // to charHeight), the rendered content is shifted up. Adjust relY so the
      // row calculation matches what the user visually clicks on.
      const subLineOffset = scrollRef.current ? scrollRef.current.scrollTop % charHeight : 0;
      relY += subLineOffset;
      return {
        x: Math.max(0, Math.floor(relX / charWidth)),
        y: Math.floor(relY / charHeight),
      };
    },
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
      focusKeyboardInput(paneId);

      // Shift+click: focus only, don't forward or start a drag-selection.
      if (e.shiftKey) {
        return;
      }

      // If mouse tracking is enabled, forward the event
      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        mouseButtonRef.current = e.button;

        // Send SGR mouse press event
        send({
          type: 'SEND_COMMAND',
          command: sgrMouseCommand(paneId, e.button, cell.x + 1, Math.max(1, cell.y + 1)),
        });
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
    [send, paneId, mouseAnyFlag, alternateOn, pixelToCell, cleanupDrag],
  );

  // Handle mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);

        // Send SGR mouse release event (lowercase 'm')
        send({
          type: 'SEND_COMMAND',
          command: sgrMouseCommand(
            paneId,
            mouseButtonRef.current,
            cell.x + 1,
            Math.max(1, cell.y + 1),
            true,
          ),
        });
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
        send({
          type: 'SEND_COMMAND',
          command: sgrMouseCommand(paneId, dragButton, cell.x + 1, Math.max(1, cell.y + 1)),
        });
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
      const rect = contentRef.current?.getBoundingClientRect();
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
      contentRef,
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
      const rect = contentRef.current?.getBoundingClientRect();
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
    [contentRef, charWidth, startAutoScroll],
  );

  // Accumulate sub-line pixel deltas across wheel events (trackpad support)
  const wheelRemainder = useRef(0);

  // Handle wheel events
  // Uses the proxy pattern: pane-wrapper is non-scrollable (overflow: hidden),
  // wheel events are intercepted and manually forwarded to the scroll container.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // When forwardScrollToParent is enabled and the pane has no scrollback,
      // let the event bubble to the parent (e.g. demo page scroll).
      if (
        forwardScrollToParent &&
        historySize === 0 &&
        !alternateOn &&
        !mouseAnyFlag &&
        !scrollbackOpen
      ) {
        return;
      }

      // A full-screen application owns the screen: the scroll is its business,
      // as line-quantized input. This is the branch that keeps the scroll view
      // out of nvim, htop, less and anything else drawing its own viewport —
      // it never opens over them.
      if (alternateOn || mouseAnyFlag) {
        e.preventDefault();
        wheelRemainder.current += e.deltaY;
        const lines = Math.trunc(wheelRemainder.current / charHeight);
        if (lines === 0) return;
        wheelRemainder.current -= lines * charHeight;

        const cell = mouseAnyFlag ? pixelToCell(e as unknown as React.MouseEvent) : { x: 0, y: 0 };
        sendScrollLines({
          send,
          paneId,
          lines,
          alternateOn,
          mouseAnyFlag,
          cellX: cell.x,
          cellY: cell.y,
        });
        return;
      }

      // A scrollback view is already open (either kind): forward the wheel
      // delta to the scroll container by hand. The wrapper is non-scrollable,
      // so native scroll never reaches the inner pane-scroll-container;
      // adjusting scrollTop fires onScroll, which reports the new top row.
      if (scrollbackOpen) {
        e.preventDefault();
        if (scrollRef.current) {
          scrollRef.current.scrollTop += e.deltaY;
        }
        return;
      }

      // Tmux is in some pane mode (e.g. server-side copy-mode entered before
      // the client caught up). Treat as alt-screen — don't re-enter copy mode.
      if (inMode) {
        e.preventDefault();
        return;
      }

      // Live screen with history behind it: scrolling up opens the scroll
      // view — scrollback you can read and select, with no cursor and nothing
      // said to tmux. Copy mode is not on this path at all any more; it is
      // reached by `prefix [`, which is the only thing that should hand a pane
      // a cursor and vi keys.
      if (historySize > 0 && e.deltaY < 0) {
        e.preventDefault();
        wheelRemainder.current += e.deltaY;
        const lines = Math.trunc(wheelRemainder.current / charHeight);
        if (lines === 0) return;
        wheelRemainder.current -= lines * charHeight;
        send({ type: 'ENTER_SCROLL_MODE', paneId, scrollLines: lines });
        return;
      }

      // Normal mode scroll down: nothing to do
      e.preventDefault();
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
