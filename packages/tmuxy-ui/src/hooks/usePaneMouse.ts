/**
 * usePaneMouse - Mouse event handler for panes
 *
 * Handles mouse clicks, drags, and wheel events based on pane state:
 * - When mouse_any_flag is true: forward mouse events as SGR sequences to tmux
 * - When alternate_on is true: wheel events send arrow keys
 * - Shift+click always focuses the pane regardless of mouse mode
 */

import { useCallback, useRef } from 'react';
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
}


export function usePaneMouse(
  send: (event: AppMachineEvent) => void,
  options: UsePaneMouseOptions
) {
  const { paneId, charWidth, charHeight, mouseAnyFlag, alternateOn } = options;

  // Track mouse button state for drag events
  const mouseButtonRef = useRef<number | null>(null);

  // Convert pixel coordinates to terminal cell coordinates
  const pixelToCell = useCallback(
    (e: React.MouseEvent, rect: DOMRect): { x: number; y: number } => {
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      return {
        x: Math.floor(relX / charWidth),
        y: Math.floor(relY / charHeight),
      };
    },
    [charWidth, charHeight]
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
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const cell = pixelToCell(e, rect);
        mouseButtonRef.current = e.button;

        // Send SGR mouse press event
        // Use invoke for the mouse event handler
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${e.button};${cell.x + 1};${cell.y + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Default: focus the pane
      send({ type: 'FOCUS_PANE', paneId });
      mouseButtonRef.current = e.button;
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const cell = pixelToCell(e, rect);

        // Send SGR mouse release event (lowercase 'm')
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${mouseButtonRef.current};${cell.x + 1};${cell.y + 1}m" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
      }

      mouseButtonRef.current = null;
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
  );

  // Handle mouse move (for drag)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;
      if (!mouseAnyFlag) return;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cell = pixelToCell(e, rect);

      // Send SGR mouse drag event (button + 32)
      const dragButton = mouseButtonRef.current + 32;
      send({
        type: 'SEND_COMMAND',
        command: `run-shell -b 'printf "\\033[<${dragButton};${cell.x + 1};${cell.y + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
      });
    },
    [send, paneId, mouseAnyFlag, pixelToCell]
  );

  // Handle mouse leave
  const handleMouseLeave = useCallback(() => {
    mouseButtonRef.current = null;
  }, []);

  // Handle wheel events
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      // Calculate number of lines to scroll
      const lines = Math.round(e.deltaY / charHeight);
      if (lines === 0) return;

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
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const cell = pixelToCell(e as unknown as React.MouseEvent, rect);
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
  };
}
