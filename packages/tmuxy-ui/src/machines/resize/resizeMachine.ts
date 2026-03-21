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
} from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';

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
    panes: [],
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

              // Find neighbor panes affected by this resize.
              // Gap between adjacent panes is 1 (real tmux) or 2 (demo: separator + header).
              const neighbors = event.panes.filter((p) => {
                if (p.tmuxId === pane.tmuxId) return false;
                // Horizontal resize affects panes to the east or west
                if (event.handle === 'e' && p.x === pane.x + pane.width + 1) return true;
                if (event.handle === 'w' && p.x + p.width + 1 === pane.x) return true;
                // Vertical resize affects panes to the north or south
                const gapS = p.y - (pane.y + pane.height);
                const gapN = pane.y - (p.y + p.height);
                if (event.handle === 's' && (gapS === 1 || gapS === 2)) return true;
                if (event.handle === 'n' && (gapN === 1 || gapN === 2)) return true;
                return false;
              });

              const resize: ResizeState = {
                paneId: event.paneId,
                handle: event.handle,
                startX: event.startX,
                startY: event.startY,
                originalPane: pane,
                originalNeighbors: neighbors,
                pixelDelta: { x: 0, y: 0 },
                delta: { cols: 0, rows: 0 },
                lastSentDelta: { cols: 0, rows: 0 },
              };
              return {
                resize,
                panes: event.panes,
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
            const { handle, lastSentDelta, paneId } = context.resize;

            const pixelDeltaX = event.clientX - context.resize.startX;
            const pixelDeltaY = event.clientY - context.resize.startY;

            const deltaCols = Math.round(pixelDeltaX / charWidth);
            const deltaRows = Math.round(pixelDeltaY / charHeight);

            const colsChanged = deltaCols !== lastSentDelta.cols;
            const rowsChanged = deltaRows !== lastSentDelta.rows;

            const needsCommand =
              ((handle === 'e' || handle === 'w') && colsChanged) ||
              ((handle === 's' || handle === 'n') && rowsChanged);

            // Track the new lastSentDelta for this event
            let newLastSentDelta = lastSentDelta;

            if (needsCommand) {
              const incrementalCols = deltaCols - lastSentDelta.cols;
              const incrementalRows = deltaRows - lastSentDelta.rows;

              const commands: string[] = [];

              if (handle === 'e' || handle === 'w') {
                if (incrementalCols !== 0) {
                  const dir = (handle === 'e' ? incrementalCols > 0 : incrementalCols < 0)
                    ? 'R'
                    : 'L';
                  const amount = Math.abs(incrementalCols);
                  commands.push(`resize-pane -t ${paneId} -${dir} ${amount}`);
                }
              }

              if (handle === 's' || handle === 'n') {
                if (incrementalRows !== 0) {
                  const dir = (handle === 's' ? incrementalRows > 0 : incrementalRows < 0)
                    ? 'D'
                    : 'U';
                  const amount = Math.abs(incrementalRows);
                  commands.push(`resize-pane -t ${paneId} -${dir} ${amount}`);
                }
              }

              if (commands.length > 0) {
                enqueue(
                  sendParent({
                    type: 'SEND_TMUX_COMMAND' as const,
                    command: commands.join(' \\; '),
                  }),
                );
                newLastSentDelta = { cols: deltaCols, rows: deltaRows };
              }
            }

            // Always update the resize state for visual feedback
            const newResize = {
              ...context.resize,
              pixelDelta: { x: pixelDeltaX, y: pixelDeltaY },
              delta: { cols: deltaCols, rows: deltaRows },
              lastSentDelta: newLastSentDelta,
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

              const commands: string[] = [];

              if (handle === 'e' || handle === 'w') {
                if (remainingCols !== 0) {
                  const dir = (handle === 'e' ? remainingCols > 0 : remainingCols < 0) ? 'R' : 'L';
                  const amount = Math.abs(remainingCols);
                  commands.push(`resize-pane -t ${paneId} -${dir} ${amount}`);
                }
              }

              if (handle === 's' || handle === 'n') {
                if (remainingRows !== 0) {
                  const dir = (handle === 's' ? remainingRows > 0 : remainingRows < 0) ? 'D' : 'U';
                  const amount = Math.abs(remainingRows);
                  commands.push(`resize-pane -t ${paneId} -${dir} ${amount}`);
                }
              }

              if (commands.length > 0) {
                enqueue(
                  sendParent({
                    type: 'SEND_TMUX_COMMAND' as const,
                    command: commands.join(' \\; '),
                  }),
                );
              }
            }),
            // Keep resize state — parent holds it as optimistic preview until
            // the next TMUX_STATE_UPDATE arrives with server-confirmed sizes.
            'notifyCompleted',
          ],
        },
        RESIZE_CANCEL: {
          target: 'idle',
          actions: [assign({ resize: null }), 'notifyStateUpdate'],
        },
      },
    },
  },
});

export type ResizeMachine = typeof resizeMachine;
