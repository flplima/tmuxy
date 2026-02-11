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
import type { DragMachineContext, DragMachineEvent, DragState, KeyPressEvent } from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { STATUS_BAR_HEIGHT, PANE_HEADER_HEIGHT } from '../../constants';
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
      const onMove = (e: MouseEvent) => sendBack({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
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
              const pane = event.panes.find(p => p.tmuxId === event.paneId);
              const drag: DragState = {
                draggedPaneId: event.paneId,
                targetPaneId: null,
                targetNewWindow: false,
                startX: event.startX,
                startY: event.startY,
                currentX: event.startX,
                currentY: event.startY,
                originalX: pane?.x ?? 0,
                originalY: pane?.y ?? 0,
                originalWidth: pane?.width ?? 0,
                originalHeight: pane?.height ?? 0,
                targetOriginalX: null,
                targetOriginalY: null,
                targetOriginalWidth: null,
                targetOriginalHeight: null,
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
          actions: [
            assign({ drag: null }),
            'notifyStateUpdate',
          ],
        },
        DRAG_MOVE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (!context.drag) return;

            const isOverStatusBar = event.clientY < STATUS_BAR_HEIGHT;

            let targetPaneId: string | null = null;

            if (!isOverStatusBar) {
              // Use dragged pane center for hit-testing (not cursor position).
              // The pane stays visually at its original CSS position during drag,
              // moved only by CSS transform. So the center is based on originalX/Y.
              const dragDeltaX = event.clientX - context.drag.startX;
              const dragDeltaY = event.clientY - context.drag.startY;
              const { originalX, originalY, originalWidth, originalHeight } = context.drag;

              const paneCenterX = (originalX + originalWidth / 2) * context.charWidth + dragDeltaX;
              const paneCenterY = (originalY + originalHeight / 2) * context.charHeight + PANE_HEADER_HEIGHT / 2 + dragDeltaY;

              targetPaneId = findSwapTarget(
                context.panes,
                context.drag.draggedPaneId,
                paneCenterX,
                paneCenterY,
                context.charWidth,
                context.charHeight,
                0,
                0
              );
            }

            const { targetPaneId: prevTargetId, draggedPaneId } = context.drag;
            const targetChanged = targetPaneId !== prevTargetId;

            // Record target's pre-swap position for drop indicator and optimistic animation
            let targetOriginalX = context.drag.targetOriginalX;
            let targetOriginalY = context.drag.targetOriginalY;
            let targetOriginalWidth = context.drag.targetOriginalWidth;
            let targetOriginalHeight = context.drag.targetOriginalHeight;

            if (targetChanged) {
              if (targetPaneId !== null) {
                const targetPane = context.panes.find(p => p.tmuxId === targetPaneId);
                if (targetPane) {
                  targetOriginalX = targetPane.x;
                  targetOriginalY = targetPane.y;
                  targetOriginalWidth = targetPane.width;
                  targetOriginalHeight = targetPane.height;
                }
              } else {
                targetOriginalX = null;
                targetOriginalY = null;
                targetOriginalWidth = null;
                targetOriginalHeight = null;
              }
            }

            // Send swap command when target changes
            // -d prevents tmux from changing the active pane during the swap
            if (targetChanged && targetPaneId !== null) {
              enqueue(
                sendParent({
                  type: 'SEND_TMUX_COMMAND' as const,
                  command: `swap-pane -d -s ${draggedPaneId} -t ${targetPaneId}`,
                })
              );
            }

            // Update local pane positions after swap for correct future hit-testing
            let updatedPanes = context.panes;
            if (targetChanged && targetPaneId !== null) {
              const draggedPane = context.panes.find(p => p.tmuxId === draggedPaneId);
              const targetPane = context.panes.find(p => p.tmuxId === targetPaneId);
              if (draggedPane && targetPane) {
                updatedPanes = context.panes.map(p => {
                  if (p.tmuxId === draggedPaneId) {
                    return { ...p, x: targetPane.x, y: targetPane.y, width: targetPane.width, height: targetPane.height };
                  }
                  if (p.tmuxId === targetPaneId) {
                    return { ...p, x: draggedPane.x, y: draggedPane.y, width: draggedPane.width, height: draggedPane.height };
                  }
                  return p;
                });
              }
            }

            // Update drag state
            enqueue(
              assign({
                panes: updatedPanes,
                drag: {
                  ...context.drag,
                  targetPaneId,
                  targetNewWindow: isOverStatusBar,
                  currentX: event.clientX,
                  currentY: event.clientY,
                  targetOriginalX,
                  targetOriginalY,
                  targetOriginalWidth,
                  targetOriginalHeight,
                },
              })
            );

            enqueue('notifyStateUpdate');
          }),
        },
        DRAG_END: {
          target: 'idle',
          actions: enqueueActions(({ context, enqueue }) => {
            if (context.drag?.targetNewWindow) {
              enqueue(
                sendParent({
                  type: 'SEND_TMUX_COMMAND' as const,
                  command: `break-pane -s ${context.drag.draggedPaneId}`,
                })
              );
            }

            enqueue(assign({ drag: null }));
            enqueue('notifyStateUpdate');
            enqueue('notifyCompleted');
          }),
        },
        DRAG_CANCEL: {
          target: 'idle',
          actions: [
            assign({ drag: null }),
            'notifyStateUpdate',
          ],
        },
      },
    },
  },
});

export type DragMachine = typeof dragMachine;
