/**
 * Divider drags: throttled resize commands each time the delta crosses a
 * whole cell, through a pointer listener spawned while resizing.
 */

import { setup, assign, sendParent, enqueueActions, fromCallback } from 'xstate';
import type {
  ResizeMachineContext,
  ResizeMachineEvent,
  ResizeState,
  KeyPressEvent,
  ResizeHandle,
} from '../types/domain';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { bandScope, resizeLimits, clampDelta } from './limits';
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

/**
 * `resize` after sending what the drag has moved since its last command, and
 * that command's steps: none while the last one is unanswered, the interval
 * has not passed, or the edge has not crossed a cell.
 */
function sendDue(resize: ResizeState, now: number): { resize: ResizeState; steps: ResizeStep[] } {
  if (resize.awaitingAnswer || now - resize.lastSentAt < RESIZE_SEND_INTERVAL_MS) {
    return { resize, steps: [] };
  }
  const steps = resizeSteps(
    resize.paneId,
    resize.handle,
    resize.delta.cols - resize.lastSentDelta.cols,
    resize.delta.rows - resize.lastSentDelta.rows,
  );
  if (steps.length === 0) return { resize, steps };
  return {
    resize: { ...resize, lastSentDelta: resize.delta, lastSentAt: now, awaitingAnswer: true },
    steps,
  };
}

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

              const tree = event.windows.find((w) => w.id === pane.windowId)?.paneTree;
              const bandGeometry = bandScope(geometry, tree, event.paneId, event.handle);

              const resize: ResizeState = {
                paneId: event.paneId,
                handle: event.handle,
                startX: event.startX,
                startY: event.startY,
                originalGeometry: geometry,
                bandGeometry,
                limits: resizeLimits(bandGeometry, event.paneId, event.handle),
                pixelDelta: { x: 0, y: 0 },
                delta: { cols: 0, rows: 0 },
                lastSentDelta: { cols: 0, rows: 0 },
                lastSentAt: 0,
                awaitingAnswer: false,
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
            const { limits } = context.resize;

            const pixelDeltaX = event.clientX - context.resize.startX;
            const pixelDeltaY = event.clientY - context.resize.startY;

            // Held inside what the panes across the line can give up. Past
            // that the divider simply stops: tmux would refuse the command,
            // and drawing the move anyway is what let the preview run away
            // from the layout.
            const moved: ResizeState = {
              ...context.resize,
              pixelDelta: { x: pixelDeltaX, y: pixelDeltaY },
              delta: {
                cols: clampDelta(Math.round(pixelDeltaX / charWidth), limits),
                rows: clampDelta(Math.round(pixelDeltaY / charHeight), limits),
              },
            };
            const { resize, steps } = sendDue(moved, Date.now());
            if (steps.length > 0) {
              enqueue(
                sendParent({ type: 'DISPATCH_OP' as const, op: TmuxOp.ResizePanes({ steps }) }),
              );
            }
            enqueue(assign({ resize }));
            enqueue(sendParent({ type: 'RESIZE_STATE_UPDATE' as const, resize }));
          }),
        },
        // The pointer may have stopped while the command was out: what it
        // moved in the meantime goes now, not at the next move.
        RESIZE_ANSWERED: {
          actions: enqueueActions(({ context, enqueue }) => {
            if (!context.resize) return;
            const { resize, steps } = sendDue(
              { ...context.resize, awaitingAnswer: false },
              Date.now(),
            );
            if (steps.length > 0) {
              enqueue(
                sendParent({ type: 'DISPATCH_OP' as const, op: TmuxOp.ResizePanes({ steps }) }),
              );
            }
            enqueue(assign({ resize }));
            enqueue(sendParent({ type: 'RESIZE_STATE_UPDATE' as const, resize }));
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
            // The parent keeps the preview until tmux's sizes settle on it.
            'notifyCompleted',
          ],
        },
      },
    },
  },
});
