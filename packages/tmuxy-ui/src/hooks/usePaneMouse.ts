/**
 * usePaneMouse - Mouse event handler for panes.
 *
 * Routes mouse input based on pane state:
 * - mouse_any_flag: forward mouse events as SGR sequences to the app in the pane
 * - alternate screen: ignore drag-selection (the app owns the screen); wheel sends arrows
 * - otherwise: drive tmux's NATIVE copy mode via `send-keys -X` commands —
 *   drag selects, double/triple-click select word/line, wheel scrolls into history.
 *
 * tmux owns the cursor, selection, and scrollback. The frontend renders what
 * tmux reports (copy cursor + selection from list-panes) and the clipboard is
 * mirrored from yanks via the backend %paste-buffer-changed bridge.
 *
 * Shift+click always focuses the pane regardless of mouse mode.
 */

import { useCallback, useRef, type RefObject } from 'react';
import type { AppMachineEvent } from '../machines/types';
import { sendScrollLines } from './scrollUtils';
import { haptics } from '../utils/haptics';
import {
  enterCopyMode,
  gotoCellCommands,
  beginSelectionCommand,
  clearSelectionCommand,
  copySelectionAndCancelCommand,
  selectWordCommands,
  selectLineCommands,
  scrollViewportCommand,
} from '../utils/nativeCopyMode';

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
  /** Whether the pane is in tmux copy mode */
  inMode: boolean;
  /** Pane height in rows (for clamping cell coordinates) */
  paneHeight: number;
  /** Ref to the .pane-content element (used for coordinate calculation) */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Number of scrollback lines above the visible terminal */
  historySize: number;
  /** When true, wheel events bubble to parent when there's nothing to scroll */
  forwardScrollToParent?: boolean;
}

/** Minimum time between drag selection updates (ms) */
const DRAG_THROTTLE_MS = 30;

export function usePaneMouse(send: (event: AppMachineEvent) => void, options: UsePaneMouseOptions) {
  const {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag,
    alternateOn,
    inMode,
    paneHeight,
    contentRef,
    historySize,
    forwardScrollToParent,
  } = options;

  // Whether we've already issued `copy-mode -e` for the current wheel-scroll
  // session. Re-sending it on every wheel tick is what previously kept the
  // viewport pinned to the bottom; we enter once, then only scroll. Reset when
  // tmux reports the pane has left copy mode.
  const enteredCopyModeRef = useRef(false);
  const prevInModeRef = useRef(inMode);
  if (prevInModeRef.current && !inMode) enteredCopyModeRef.current = false;
  prevInModeRef.current = inMode;

  // Mouse button state for drag events (null = no button held)
  const mouseButtonRef = useRef<number | null>(null);
  // Drag selection state
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const isSelectingRef = useRef(false);
  const lastDragTimeRef = useRef(0);
  // Document-level mouseup listener (for releases outside the pane)
  const documentMouseUpRef = useRef<((e: MouseEvent) => void) | null>(null);

  // Dispatch an ordered batch of tmux commands.
  const run = useCallback(
    (commands: string[]) => {
      for (const command of commands) send({ type: 'SEND_COMMAND', command });
    },
    [send],
  );

  // Convert pixel coordinates to visible-viewport cell coordinates, relative to
  // the .pane-content element (below the header). Row is clamped to the visible
  // area so drags past the top/bottom edge select the first/last visible line.
  const pixelToCell = useCallback(
    (e: React.MouseEvent): { x: number; y: number } => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      return {
        x: Math.max(0, Math.floor(relX / charWidth)),
        y: Math.max(0, Math.min(paneHeight - 1, Math.floor(relY / charHeight))),
      };
    },
    [charWidth, charHeight, contentRef, paneHeight],
  );

  const cleanupDrag = useCallback(() => {
    dragStartRef.current = null;
    isSelectingRef.current = false;
    mouseButtonRef.current = null;
    if (documentMouseUpRef.current) {
      document.removeEventListener('mouseup', documentMouseUpRef.current);
      documentMouseUpRef.current = null;
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;

      // Focus unconditionally — FOCUS_PANE is a no-op when already active.
      haptics.trigger(10);
      send({ type: 'FOCUS_PANE', paneId });

      // Shift+click: focus only.
      if (e.shiftKey) return;

      // Mouse-tracking app: forward SGR press.
      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        mouseButtonRef.current = e.button;
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${e.button};${cell.x + 1};${Math.max(1, cell.y + 1)}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      // Alternate-screen apps (nvim, less) without mouse tracking: don't start a
      // drag-selection — copy mode operates on scrollback hidden behind the alt
      // buffer, so dragging would pop the user into an unrelated view.
      if (alternateOn) return;

      // Prepare for a potential drag selection.
      if (e.button === 0) {
        mouseButtonRef.current = 0;
        dragStartRef.current = pixelToCell(e);
        isSelectingRef.current = false;
        if (documentMouseUpRef.current) {
          document.removeEventListener('mouseup', documentMouseUpRef.current);
        }
        documentMouseUpRef.current = () => cleanupDrag();
        document.addEventListener('mouseup', documentMouseUpRef.current);
      }
    },
    [send, paneId, mouseAnyFlag, alternateOn, pixelToCell, cleanupDrag],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${mouseButtonRef.current};${cell.x + 1};${Math.max(1, cell.y + 1)}m" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        mouseButtonRef.current = null;
        return;
      }

      if (isSelectingRef.current) {
        // Drag released: copy the selection (clipboard bridge) and exit copy mode.
        run([copySelectionAndCancelCommand(paneId)]);
      } else if (inMode && e.button === 0) {
        // Plain click while in copy mode: clear selection and move the copy cursor.
        const cell = pixelToCell(e);
        run([clearSelectionCommand(paneId), ...gotoCellCommands(paneId, cell.x, cell.y)]);
      }
      cleanupDrag();
    },
    [send, paneId, mouseAnyFlag, inMode, pixelToCell, run, cleanupDrag],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (mouseButtonRef.current === null) return;

      if (mouseAnyFlag) {
        const cell = pixelToCell(e);
        const dragButton = mouseButtonRef.current + 32;
        send({
          type: 'SEND_COMMAND',
          command: `run-shell -b 'printf "\\033[<${dragButton};${cell.x + 1};${Math.max(1, cell.y + 1)}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
        });
        return;
      }

      if (alternateOn || !dragStartRef.current || mouseButtonRef.current !== 0) return;

      const now = Date.now();
      if (now - lastDragTimeRef.current < DRAG_THROTTLE_MS) return;
      lastDragTimeRef.current = now;

      const cell = pixelToCell(e);
      const start = dragStartRef.current;

      if (!isSelectingRef.current) {
        if (cell.x === start.x && cell.y === start.y) return; // not moved a cell yet
        isSelectingRef.current = true;
        // Enter copy mode, anchor selection at the drag start, then extend to the
        // current cell. tmux extends the selection as the cursor moves.
        run([
          enterCopyMode(paneId),
          ...gotoCellCommands(paneId, start.x, start.y),
          beginSelectionCommand(paneId),
          ...gotoCellCommands(paneId, cell.x, cell.y),
        ]);
        return;
      }

      // Extend the selection by repositioning the cursor.
      run(gotoCellCommands(paneId, cell.x, cell.y));
    },
    [send, paneId, mouseAnyFlag, alternateOn, pixelToCell, run],
  );

  const handleMouseLeave = useCallback(() => {
    // Drag selection continues via the document-level mouseup listener; only
    // reset button state when not actively selecting.
    if (!isSelectingRef.current) {
      dragStartRef.current = null;
      mouseButtonRef.current = null;
    }
  }, []);

  // Accumulate sub-line pixel deltas across wheel events (trackpad support)
  const wheelRemainder = useRef(0);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // Demo page: let the event bubble when there's nothing to scroll.
      if (forwardScrollToParent && historySize === 0 && !alternateOn && !mouseAnyFlag && !inMode) {
        return;
      }

      e.preventDefault();
      wheelRemainder.current += e.deltaY;
      const lines = Math.trunc(wheelRemainder.current / charHeight);
      if (lines === 0) return;
      wheelRemainder.current -= lines * charHeight;

      if (alternateOn || mouseAnyFlag) {
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

      // Normal shell: nothing to do when already at the bottom and scrolling
      // down, or when there is no history to scroll into.
      if (!inMode && lines > 0) return;
      if (!inMode && historySize === 0) return;

      // Enter tmux copy mode once, then only scroll on subsequent ticks. The
      // ref covers the window where pane.inMode hasn't caught up to our entry.
      const cmds: string[] = [];
      if (!inMode && !enteredCopyModeRef.current) {
        cmds.push(enterCopyMode(paneId, true));
        enteredCopyModeRef.current = true;
      }
      const scroll = scrollViewportCommand(paneId, lines);
      if (scroll) cmds.push(scroll);
      run(cmds);
    },
    [
      send,
      paneId,
      charHeight,
      alternateOn,
      mouseAnyFlag,
      inMode,
      pixelToCell,
      historySize,
      forwardScrollToParent,
      run,
    ],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (mouseAnyFlag || alternateOn) return;
      if (e.detail >= 3) return; // triple-click handled separately
      const cell = pixelToCell(e);
      run(selectWordCommands(paneId, cell.x, cell.y));
    },
    [paneId, mouseAnyFlag, alternateOn, pixelToCell, run],
  );

  const handleTripleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (mouseAnyFlag || alternateOn) return;
      e.preventDefault();
      const cell = pixelToCell(e);
      run(selectLineCommands(paneId, cell.y));
    },
    [paneId, mouseAnyFlag, alternateOn, pixelToCell, run],
  );

  return {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    handleDoubleClick,
    handleTripleClick,
  };
}
