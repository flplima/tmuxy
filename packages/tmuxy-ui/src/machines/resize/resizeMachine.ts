/**
 * Resize Machine - Handles pane resize operations
 *
 * Sends throttled tmux commands when the resize delta crosses a character threshold.
 * Spawns its own pointer listener when entering the resizing state.
 * Throttle state is kept in machine context (not module-level).
 *
 * States:
 * - idle: No resize in progress
 * - resizing: Pane divider is being dragged, commands sent with throttling
 */

import { setup, assign, sendParent, enqueueActions, fromCallback } from 'xstate';
import type {
  ResizeMachineContext,
  ResizeMachineEvent,
  ResizeState,
  KeyPressEvent,
  ResizeHandle,
} from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { resizeLimits, clampDelta } from './limits';
import { TmuxOp, type ResizeStep } from '../../domain/commands';
import type { PaneId } from '../../domain/ids';

/**
 * The resize a divider drag of `cols` × `rows` cells asks of `paneId`: an east
 * or west handle moves its column edge, a south or north one its row edge, in
 * the direction the edge travels.
 */
function resizeSteps(
  paneId: PaneId,
  handle: ResizeHandle,
  cols: number,
  rows: number,
): ResizeStep[] {
  if ((handle === 'e' || handle === 'w') && cols !== 0) {
    const grows = handle === 'e' ? cols > 0 : cols < 0;
    return [{ paneId, direction: grows ? 'R' : 'L', cells: Math.abs(cols) }];
  }
  if ((handle === 's' || handle === 'n') && rows !== 0) {
    const grows = handle === 's' ? rows > 0 : rows < 0;
    return [{ paneId, direction: grows ? 'D' : 'U', cells: Math.abs(rows) }];
  }
  return [];
}

/** Minimum ms between resize command batches during a drag (see ResizeState.lastSentAt). */
export const RESIZE_SEND_INTERVAL_MS = 80;

export const resizeMachine = setup({
  types: {
    context: {} as ResizeMachineContext,
    events: {} as ResizeMachineEvent,
  },
  guards: {
    isEscapeKey: ({ event }) => (event as KeyPressEvent).key === 'Escape',
  },
  actions: {
    notifyStateUpdate: sendParent(({ context }) => ({
      type: 'RESIZE_STATE_UPDATE' as const,
      resize: context.resize,
    })),
    notifyCompleted: sendParent({ type: 'RESIZE_COMPLETED' as const }),
  },
  actors: {
    pointerTracker: fromCallback(({ sendBack }) => {
      const onMove = (e: MouseEvent) =>
        sendBack({ type: 'RESIZE_MOVE', clientX: e.clientX, clientY: e.clientY });
      const onUp = () => sendBack({ type: 'RESIZE_END' });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }),
  },
}).createMachine({
  id: 'resize',
  initial: 'idle',
  context: {
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    resize: null,
  },
  states: {
    idle: {
      on: {
        RESIZE_START: {
          target: 'resizing',
          actions: [
            assign(({ event }) => {
              const pane = event.panes.find((p) => p.tmuxId === event.paneId);
              if (!pane) return {};

              // Only this window's panes: coordinates are per-window, so a
              // pane from another tab sitting at the same x/y would read as a
              // neighbour and give the drag a limit that belongs to a layout
              // nobody is looking at.
              const geometry = Object.fromEntries(
                event.panes
                  .filter((p) => p.windowId === pane.windowId)
                  .map((p) => [p.tmuxId, { x: p.x, y: p.y, width: p.width, height: p.height }]),
              );

              const resize: ResizeState = {
                paneId: event.paneId,
                handle: event.handle,
                startX: event.startX,
                startY: event.startY,
                originalGeometry: geometry,
                limits: resizeLimits(geometry, event.paneId, event.handle),
                pixelDelta: { x: 0, y: 0 },
                delta: { cols: 0, rows: 0 },
                lastSentDelta: { cols: 0, rows: 0 },
                lastSentAt: 0,
              };
              return {
                resize,
                charWidth: event.charWidth,
                charHeight: event.charHeight,
              };
            }),
            'notifyStateUpdate',
          ],
        },
      },
    },

    resizing: {
      invoke: {
        id: 'pointerTracker',
        src: 'pointerTracker',
      },
      on: {
        KEY_PRESS: {
          guard: 'isEscapeKey',
          target: 'idle',
          actions: [assign({ resize: null }), 'notifyStateUpdate'],
        },
        RESIZE_MOVE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (!context.resize) return;

            const { charWidth, charHeight } = context;
            const { handle, lastSentDelta, lastSentAt, paneId, limits } = context.resize;

            const pixelDeltaX = event.clientX - context.resize.startX;
            const pixelDeltaY = event.clientY - context.resize.startY;

            // Held inside what the panes across the line can give up. Past
            // that the divider simply stops: tmux would refuse the command,
            // and drawing the move anyway is what let the preview run away
            // from the layout.
            const deltaCols = clampDelta(Math.round(pixelDeltaX / charWidth), limits);
            const deltaRows = clampDelta(Math.round(pixelDeltaY / charHeight), limits);

            const colsChanged = deltaCols !== lastSentDelta.cols;
            const rowsChanged = deltaRows !== lastSentDelta.rows;

            // Coalesce wire traffic: at most one command batch per interval.
            // The visual preview (assigned below) still updates every move;
            // RESIZE_END flushes whatever delta remains unsent.
            const now = Date.now();
            const throttleOpen = now - lastSentAt >= RESIZE_SEND_INTERVAL_MS;

            const needsCommand =
              throttleOpen &&
              (((handle === 'e' || handle === 'w') && colsChanged) ||
                ((handle === 's' || handle === 'n') && rowsChanged));

            // Track the new lastSentDelta for this event
            let newLastSentDelta = lastSentDelta;
            let newLastSentAt = lastSentAt;

            if (needsCommand) {
              const incrementalCols = deltaCols - lastSentDelta.cols;
              const incrementalRows = deltaRows - lastSentDelta.rows;

              const steps = resizeSteps(paneId, handle, incrementalCols, incrementalRows);
              if (steps.length > 0) {
                enqueue(
                  sendParent({ type: 'DISPATCH_OP' as const, op: TmuxOp.ResizePanes({ steps }) }),
                );
                newLastSentDelta = { cols: deltaCols, rows: deltaRows };
                newLastSentAt = now;
              }
            }

            // Always update the resize state for visual feedback
            const newResize = {
              ...context.resize,
              pixelDelta: { x: pixelDeltaX, y: pixelDeltaY },
              delta: { cols: deltaCols, rows: deltaRows },
              lastSentDelta: newLastSentDelta,
              lastSentAt: newLastSentAt,
            };
            enqueue(assign({ resize: newResize }));
            enqueue(sendParent({ type: 'RESIZE_STATE_UPDATE' as const, resize: newResize }));
          }),
        },
        RESIZE_END: {
          target: 'idle',
          actions: [
            enqueueActions(({ context, enqueue }) => {
              if (!context.resize) return;

              const { handle, delta, lastSentDelta, paneId } = context.resize;

              const remainingCols = delta.cols - lastSentDelta.cols;
              const remainingRows = delta.rows - lastSentDelta.rows;

              const steps = resizeSteps(paneId, handle, remainingCols, remainingRows);
              if (steps.length > 0) {
                enqueue(
                  sendParent({ type: 'DISPATCH_OP' as const, op: TmuxOp.ResizePanes({ steps }) }),
                );
              }
            }),
            // Keep resize state — parent holds it as optimistic preview until
            // the next TMUX_STATE_UPDATE arrives with server-confirmed sizes.
            'notifyCompleted',
          ],
        },
      },
    },
  },
});

export type ResizeMachine = typeof resizeMachine;
