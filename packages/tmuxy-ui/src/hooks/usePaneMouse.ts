/**
 * usePaneMouse - Mouse event handler for panes
 *
 * Handles mouse clicks, drags, and wheel events based on pane state:
 * - When mouse_any_flag is true: forward mouse events as SGR sequences to tmux
 * - When mouse_any_flag is false: mouse drag enters copy mode and creates selection
 * - When alternate_on is true: wheel events send arrow keys
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
  /** Ref to the .pane-content element (used for coordinate calculation) */
  contentRef: RefObject<HTMLDivElement | null>;
}

/** Minimum time between drag updates (ms) */
const DRAG_THROTTLE_MS = 30;

export function usePaneMouse(
  send: (event: AppMachineEvent) => void,
  options: UsePaneMouseOptions
) {
  const { paneId, charWidth, charHeight, mouseAnyFlag, alternateOn, inMode, contentRef } = options;

  // Track mouse button state for drag events
  const mouseButtonRef = useRef<number | null>(null);

  // Track mouse drag state for copy-mode selection
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingForSelectionRef = useRef(false);
  const lastDragTimeRef = useRef(0);
  // Snapshot inMode at mousedown so we don't lose state mid-drag
  const wasModeAtDragStartRef = useRef(false);
  // Committed selection start (reactive state for rendering, persists until copy mode exits)
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

  // Clear selection start when copy mode exits
  if (!inMode && selectionStart) {
    setSelectionStart(null);
  }

  // Convert pixel coordinates to terminal cell coordinates
  // Uses the .pane-content element's rect so coordinates are relative to the
  // terminal content area (below the header), not the entire pane wrapper.
  const pixelToCell = useCallback(
    (e: React.MouseEvent): { x: number; y: number } => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      return {
        x: Math.max(0, Math.floor(relX / charWidth)),
        y: Math.max(0, Math.floor(relY / charHeight)),
      };
    },
    [charWidth, charHeight, contentRef]
  );

  // Note: SGR mouse events are sent using printf + load-buffer + paste-buffer
  // because tmux's send-keys -M format is different from SGR encoding

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
          command: `run-shell -b 'printf "\\033[<${e.button};${cell.x + 1};${cell.y + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Default: focus the pane and prepare for potential drag selection
      send({ type: 'FOCUS_PANE', paneId });
      mouseButtonRef.current = e.button;

      if (e.button === 0) {
        const cell = pixelToCell(e);
        dragStartRef.current = cell;
        lastCellRef.current = null;
        isDraggingForSelectionRef.current = false;
        wasModeAtDragStartRef.current = inMode;
      }
    },
    [send, paneId, mouseAnyFlag, inMode, pixelToCell]
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
          command: `run-shell -b 'printf "\\033[<${mouseButtonRef.current};${cell.x + 1};${cell.y + 1}m" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
      }

      // Commit the selection start if a drag selection was made
      if (isDraggingForSelectionRef.current && dragStartRef.current) {
        setSelectionStart({ ...dragStartRef.current });
      }

      // Clear drag state
      dragStartRef.current = null;
      lastCellRef.current = null;
      isDraggingForSelectionRef.current = false;
      mouseButtonRef.current = null;
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
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
          command: `run-shell -b 'printf "\\033[<${dragButton};${cell.x + 1};${cell.y + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Non-mouse-tracking: handle drag for copy-mode selection
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

        // Chain commands with \; so tmux processes them atomically.
        // This is critical: copy-mode must complete before send-keys -X works.
        const parts: string[] = [];
        if (!wasModeAtDragStartRef.current) {
          parts.push(`copy-mode -t ${paneId}`);
        }
        parts.push(`send-keys -t ${paneId} -X top-line`);
        parts.push(`send-keys -t ${paneId} -X start-of-line`);
        if (start.y > 0) {
          parts.push(`send-keys -t ${paneId} -X -N ${start.y} cursor-down`);
        }
        if (start.x > 0) {
          parts.push(`send-keys -t ${paneId} -X -N ${start.x} cursor-right`);
        }
        parts.push(`set -p -t ${paneId} @tmuxy_sel_mode char`);
        parts.push(`send-keys -t ${paneId} -X begin-selection`);

        send({ type: 'SEND_COMMAND', command: parts.join(' \\; ') });
        lastCellRef.current = { ...start };
      }

      // Move cursor to current position (relative from last known position)
      if (lastCellRef.current) {
        const dx = cell.x - lastCellRef.current.x;
        const dy = cell.y - lastCellRef.current.y;

        if (dy > 0) {
          send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} -X -N ${dy} cursor-down` });
        } else if (dy < 0) {
          send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} -X -N ${-dy} cursor-up` });
        }

        if (dx > 0) {
          send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} -X -N ${dx} cursor-right` });
        } else if (dx < 0) {
          send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} -X -N ${-dx} cursor-left` });
        }

        lastCellRef.current = cell;
      }
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
  );

  // Handle mouse leave
  const handleMouseLeave = useCallback(() => {
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

      // Default: enter copy mode and scroll
      const direction = isScrollUp ? 'scroll-up' : 'scroll-down';
      send({ type: 'SEND_COMMAND', command: `copy-mode -e -t ${paneId}` });
      send({
        type: 'SEND_COMMAND',
        command: `send-keys -t ${paneId} -X -N ${absLines} ${direction}`,
      });
    },
    [send, paneId, charHeight, alternateOn, mouseAnyFlag, pixelToCell]
  );

  return {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    /** Selection start cell position for rendering selection overlay */
    selectionStart,
  };
}
