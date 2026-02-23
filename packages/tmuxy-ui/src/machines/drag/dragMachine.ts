/**
 * Drag Machine - Handles pane drag-to-swap operations
 *
 * Sends real-time swap commands when drag target changes.
 * The dragged pane follows the cursor while other panes swap in real-time.
 * Spawns its own pointer listener when entering the dragging state.
 *
 * States:
 * - idle: No drag in progress
 * - dragging: Pane is being dragged, swaps happen on target change
 */

import { setup, assign, sendParent, enqueueActions, fromCallback } from 'xstate';
import type {
  DragMachineContext,
  DragMachineEvent,
  DragState,
  KeyPressEvent,
  TmuxPane,
} from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { findSwapTarget } from './helpers';

export const dragMachine = setup({
  types: {
    context: {} as DragMachineContext,
    events: {} as DragMachineEvent,
  },
  guards: {
    isEscapeKey: ({ event }) => (event as KeyPressEvent).key === 'Escape',
  },
  actions: {
    notifyStateUpdate: sendParent(({ context }) => ({
      type: 'DRAG_STATE_UPDATE' as const,
      drag: context.drag,
    })),
    notifyCompleted: sendParent({ type: 'DRAG_COMPLETED' as const }),
  },
  actors: {
    pointerTracker: fromCallback(({ sendBack }) => {
      const onMove = (e: MouseEvent) =>
        sendBack({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
      const onUp = () => sendBack({ type: 'DRAG_END' });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }),
  },
}).createMachine({
  id: 'drag',
  initial: 'idle',
  context: {
    panes: [],
    activePaneId: null,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    containerWidth: 0,
    containerHeight: 0,
    drag: null,
  },
  states: {
    idle: {
      on: {
        DRAG_START: {
          target: 'dragging',
          actions: [
            assign(({ event }) => {
              const pane = event.panes.find((p) => p.tmuxId === event.paneId);
              const drag: DragState = {
                draggedPaneId: event.paneId,
                targetPaneId: null,

                startX: event.startX,
                startY: event.startY,
                currentX: event.startX,
                currentY: event.startY,
                originalX: pane?.x ?? 0,
                originalY: pane?.y ?? 0,
                originalWidth: pane?.width ?? 0,
                originalHeight: pane?.height ?? 0,
                ghostX: pane?.x ?? 0,
                ghostY: pane?.y ?? 0,
                ghostWidth: pane?.width ?? 0,
                ghostHeight: pane?.height ?? 0,
              };
              return {
                drag,
                panes: event.panes,
                charWidth: event.charWidth,
                charHeight: event.charHeight,
                containerWidth: event.containerWidth,
                containerHeight: event.containerHeight,
              };
            }),
            'notifyStateUpdate',
          ],
        },
      },
    },

    dragging: {
      invoke: {
        id: 'pointerTracker',
        src: 'pointerTracker',
      },
      on: {
        KEY_PRESS: {
          guard: 'isEscapeKey',
          target: 'idle',
          actions: [assign({ drag: null }), 'notifyStateUpdate'],
        },
        SYNC_PANES: {
          actions: assign(({ event }) => ({
            panes: (event as { type: 'SYNC_PANES'; panes: TmuxPane[] }).panes,
          })),
        },
        DRAG_MOVE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (!context.drag) return;

            // Compute centering offset (panes are centered in the container)
            const totalW = Math.max(...context.panes.map((p) => p.x + p.width));
            const totalH = Math.max(...context.panes.map((p) => p.y + p.height));
            const centerOffsetX = Math.max(
              0,
              (context.containerWidth - totalW * context.charWidth) / 2,
            );
            const centerOffsetY = Math.max(
              0,
              (context.containerHeight - totalH * context.charHeight) / 2,
            );

            // Use the cursor position directly for hit-testing.
            // The ghost center can diverge from the cursor after swaps (since the
            // ghost snaps to each target's position), making some panes unreachable.
            const paneCenterX = event.clientX;
            const paneCenterY = event.clientY;

            const targetPaneId = findSwapTarget(
              context.panes,
              context.drag.draggedPaneId,
              paneCenterX,
              paneCenterY,
              context.charWidth,
              context.charHeight,
              centerOffsetX,
              centerOffsetY,
            );

            const { targetPaneId: prevTargetId } = context.drag;
            const targetChanged = targetPaneId !== prevTargetId;

            let ghostX = context.drag.ghostX;
            let ghostY = context.drag.ghostY;
            let ghostWidth = context.drag.ghostWidth;
            let ghostHeight = context.drag.ghostHeight;
            let newPanes = context.panes;

            // Swap on hover: when target changes, swap immediately
            if (targetChanged && targetPaneId !== null) {
              const targetPane = context.panes.find((p) => p.tmuxId === targetPaneId);
              const draggedPane = context.panes.find(
                (p) => p.tmuxId === context.drag!.draggedPaneId,
              );

              if (targetPane && draggedPane) {
                // Ghost moves to target's current position
                ghostX = targetPane.x;
                ghostY = targetPane.y;
                ghostWidth = targetPane.width;
                ghostHeight = targetPane.height;

                // Optimistic swap: update local pane positions for accurate hit testing
                newPanes = context.panes.map((p) => {
                  if (p.tmuxId === context.drag!.draggedPaneId) {
                    return {
                      ...p,
                      x: targetPane.x,
                      y: targetPane.y,
                      width: targetPane.width,
                      height: targetPane.height,
                    };
                  }
                  if (p.tmuxId === targetPaneId) {
                    return {
                      ...p,
                      x: draggedPane.x,
                      y: draggedPane.y,
                      width: draggedPane.width,
                      height: draggedPane.height,
                    };
                  }
                  return p;
                });

                // Send swap command to tmux
                enqueue(
                  sendParent({
                    type: 'SEND_TMUX_COMMAND' as const,
                    command: `swap-pane -d -s ${context.drag!.draggedPaneId} -t ${targetPaneId}`,
                  }),
                );
              }
            }

            enqueue(
              assign({
                panes: newPanes,
                drag: {
                  ...context.drag,
                  targetPaneId,
                  currentX: event.clientX,
                  currentY: event.clientY,
                  ghostX,
                  ghostY,
                  ghostWidth,
                  ghostHeight,
                },
              }),
            );

            enqueue('notifyStateUpdate');
          }),
        },
        DRAG_END: {
          target: 'idle',
          actions: [
            // Swaps already happened on hover — just clear state
            assign({ drag: null }),
            'notifyStateUpdate',
            'notifyCompleted',
          ],
        },
        DRAG_CANCEL: {
          target: 'idle',
          actions: [assign({ drag: null }), 'notifyStateUpdate'],
        },
      },
    },
  },
});

export type DragMachine = typeof dragMachine;
