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

import { useCallback, useRef, useState, type RefObject } from 'react';
import type { AppMachineEvent } from '../machines/types';

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
  /** Whether client-side copy mode is active */
  copyModeActive: boolean;
  /** Pane height in rows (for scroll calculations) */
  paneHeight: number;
  /** Ref to the .pane-content element (used for coordinate calculation) */
  contentRef: RefObject<HTMLDivElement | null>;
}

/** Minimum time between drag updates (ms) */
const DRAG_THROTTLE_MS = 30;

/** Auto-scroll interval (ms) */
const AUTO_SCROLL_INTERVAL_MS = 50;

/** Auto-scroll speed (lines per tick) */
const AUTO_SCROLL_LINES = 2;

export function usePaneMouse(
  send: (event: AppMachineEvent) => void,
  options: UsePaneMouseOptions
) {
  const { paneId, charWidth, charHeight, mouseAnyFlag, alternateOn, inMode, copyModeActive, contentRef } = options;

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

  // Convert pixel coordinates to terminal cell coordinates
  // Uses the .pane-content element's rect so coordinates are relative to the
  // terminal content area (below the header), not the entire pane wrapper.
  // Does NOT clamp Y so we can detect above/below for auto-scroll.
  const pixelToCell = useCallback(
    (e: React.MouseEvent): { x: number; y: number } => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      return {
        x: Math.max(0, Math.floor(relX / charWidth)),
        y: Math.floor(relY / charHeight),
      };
    },
    [charWidth, charHeight, contentRef]
  );

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't handle clicks on the header (drag is handled separately)
      if (target.closest('.pane-header')) return;

      // Shift+click always focuses pane, regardless of mouse mode
      if (e.shiftKey) {
        send({ type: 'FOCUS_PANE', paneId });
        return;
      }

      // If mouse tracking is enabled, forward the event
      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        mouseButtonRef.current = e.button;

        // Send SGR mouse press event
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${e.button};${cell.x + 1};${Math.max(1, cell.y + 1)}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Default: focus the pane and prepare for potential drag selection
      send({ type: 'FOCUS_PANE', paneId });
      mouseButtonRef.current = e.button;

      if (e.button === 0) {
        const cell = pixelToCell(e);
        dragStartRef.current = { x: cell.x, y: Math.max(0, cell.y) };
        lastCellRef.current = null;
        isDraggingForSelectionRef.current = false;
      }
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      stopAutoScroll();

      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);

        // Send SGR mouse release event (lowercase 'm')
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${mouseButtonRef.current};${cell.x + 1};${Math.max(1, cell.y + 1)}m" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
      }

      // Commit the selection start if a drag selection was made
      if (isDraggingForSelectionRef.current && dragStartRef.current) {
        setSelectionStart({ ...dragStartRef.current });
      }

      // Single click (no drag) in copy mode: clear selection and move cursor
      if (!isDraggingForSelectionRef.current && copyModeActive && e.button === 0) {
        const target = e.target as HTMLElement;
        if (!target.closest('.pane-header')) {
          const cell = pixelToCell(e);
          send({ type: 'COPY_MODE_SELECTION_CLEAR', paneId });
          send({ type: 'COPY_MODE_CURSOR_MOVE', paneId, row: Math.max(0, cell.y), col: cell.x, relative: true });
        }
      }

      // Clear drag state
      dragStartRef.current = null;
      lastCellRef.current = null;
      isDraggingForSelectionRef.current = false;
      mouseButtonRef.current = null;
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell, stopAutoScroll]
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
          command: `run-shell -b 'printf "\\033[<${dragButton};${cell.x + 1};${Math.max(1, cell.y + 1)}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Non-mouse-tracking: handle drag for client-side copy mode selection
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

        // Enter client-side copy mode if not already active
        if (!copyModeActive) {
          send({ type: 'ENTER_COPY_MODE', paneId });
        }

        // We'll set selection after copy mode state is initialized
        // For now, use a small delay for state to propagate
        setTimeout(() => {
          send({
            type: 'COPY_MODE_SELECTION_START',
            paneId,
            mode: 'char',
            row: start.y,
            col: start.x,
          });
        }, 50);
        lastCellRef.current = { ...start };
      }

      // Check if mouse is above or below content area for auto-scroll
      const rect = contentRef.current?.getBoundingClientRect();
      if (rect && isDraggingForSelectionRef.current) {
        const relY = e.clientY - rect.top;
        const isAbove = relY < 0;
        const isBelow = relY >= rect.height;

        if (isAbove || isBelow) {
          autoScrollColRef.current = cell.x;
          if (autoScrollTimerRef.current === null) {
            const direction = isAbove ? -1 : 1;
            autoScrollTimerRef.current = window.setInterval(() => {
              // Send cursor move to row above/below visible area
              // The machine auto-adjusts scrollTop when cursor goes out of viewport
              const targetRow = direction < 0 ? -AUTO_SCROLL_LINES : options.paneHeight + AUTO_SCROLL_LINES - 1;
              send({
                type: 'COPY_MODE_CURSOR_MOVE',
                paneId,
                row: targetRow,
                col: autoScrollColRef.current,
                relative: true,
              });
            }, AUTO_SCROLL_INTERVAL_MS);
          }
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
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell, contentRef, options.paneHeight, stopAutoScroll]
  );

  // Handle mouse leave - only clear state if not actively dragging for selection
  const handleMouseLeave = useCallback(() => {
    if (isDraggingForSelectionRef.current) return;
    dragStartRef.current = null;
    lastCellRef.current = null;
    isDraggingForSelectionRef.current = false;
    mouseButtonRef.current = null;
  }, []);

  // Accumulate sub-line pixel deltas across wheel events (trackpad support)
  const wheelRemainder = useRef(0);

  // Handle wheel events
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // In copy mode, let native scroll handle it (ScrollbackTerminal has overflow-y:auto)
      if (copyModeActive) return;

      e.preventDefault();

      // Accumulate pixel delta and convert to lines
      wheelRemainder.current += e.deltaY;
      const lines = Math.trunc(wheelRemainder.current / charHeight);
      if (lines === 0) return;
      wheelRemainder.current -= lines * charHeight;

      const isScrollUp = lines < 0;
      const absLines = Math.abs(lines);

      // If in alternate screen (vim, less), send arrow keys
      if (alternateOn) {
        const key = isScrollUp ? 'Up' : 'Down';
        for (let i = 0; i < absLines; i++) {
          send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} ${key}` });
        }
        return;
      }

      // If mouse tracking is enabled, forward wheel events
      if (mouseAnyFlag) {
        const cell = pixelToCell(e as unknown as React.MouseEvent);
        const button = isScrollUp ? 64 : 65;

        // Send wheel events
        for (let i = 0; i < absLines; i++) {
          send({
            type: 'SEND_COMMAND',
            command: `run-shell -b 'printf "\\033[<${button};${cell.x + 1};${cell.y + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
          });
        }
        return;
      }

      // Default: enter client-side copy mode on scroll up (with scroll delta preserved)
      if (isScrollUp) {
        send({ type: 'ENTER_COPY_MODE', paneId, scrollLines: lines });
      } else {
        // Scroll down without copy mode - just send to tmux
        send({ type: 'SEND_COMMAND', command: `copy-mode -e -t ${paneId}` });
        send({
          type: 'SEND_COMMAND',
          command: `send-keys -t ${paneId} -X -N ${absLines} scroll-down`,
        });
      }
    },
    [send, paneId, charHeight, alternateOn, mouseAnyFlag, copyModeActive, pixelToCell]
  );

  // Handle double-click for word selection
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (mouseAnyFlag) return;

      const cell = pixelToCell(e);

      if (!copyModeActive) {
        send({ type: 'ENTER_COPY_MODE', paneId });
        // Delay word select until copy mode state is initialized
        setTimeout(() => {
          send({ type: 'COPY_MODE_WORD_SELECT', paneId, row: cell.y, col: cell.x });
        }, 100);
      } else {
        send({ type: 'COPY_MODE_WORD_SELECT', paneId, row: cell.y, col: cell.x });
      }
    },
    [send, paneId, mouseAnyFlag, copyModeActive, pixelToCell]
  );

  return {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    handleDoubleClick,
    /** Selection start cell position for rendering selection overlay */
    selectionStart,
  };
}
