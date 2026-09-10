/**
 * Drag Machine - Handles pane drag-to-swap operations
 *
 * Sends real-time swap commands when drag target changes.
 * The dragged pane follows the cursor while other panes swap in real-time.
 * Spawns its own pointer listener when entering the dragging state.
 *
 * Dragging up onto the tab strip means something else: the pane leaves this
 * tab. Over another tab it joins that one, over the empty space after the last
 * tab it becomes a tab of its own, and while the pointer is up there no swap
 * runs, because the panes it is passing over are not what the gesture is
 * about. Unlike a swap, which happens the moment the pointer crosses a pane,
 * this one waits for the release: moving a pane between tabs is disruptive
 * enough that passing over a tab on the way somewhere else must not do it.
 *
 * States:
 * - idle: No drag in progress
 * - dragging: Pane is being dragged, swaps happen on target change
 */

import { setup, assign, sendParent, enqueueActions, fromCallback } from 'xstate';
import type { DragMachineContext, DragMachineEvent, DragState, KeyPressEvent } from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { findSwapTarget } from './helpers';
import { tabStripDrop, tabDropCommand, sameTabDrop } from '../../utils/tabStripDrop';
import { haptics } from '../../utils/haptics';

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
    hapticSwap: () => haptics.trigger('selection'),
  },
  actors: {
    pointerTracker: fromCallback(({ sendBack }) => {
      // Fire start haptic in event handler context (required for navigator.vibrate)
      haptics.trigger('medium');
      const onMove = (e: MouseEvent) =>
        sendBack({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
      const onUp = () => {
        haptics.trigger('success');
        sendBack({ type: 'DRAG_END' });
      };
      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        const t = e.touches[0];
        sendBack({ type: 'DRAG_MOVE', clientX: t.clientX, clientY: t.clientY });
      };
      const onTouchEnd = () => {
        haptics.trigger('success');
        sendBack({ type: 'DRAG_END' });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
      window.addEventListener('touchcancel', onTouchEnd);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('touchcancel', onTouchEnd);
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
    containerLeft: 0,
    containerTop: 0,
    tabStrip: null,
    paneWindowId: null,
    panesInWindow: 0,
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
                tabDrop: null,
              };
              return {
                drag,
                panes: event.panes,
                tabStrip: event.tabStrip,
                paneWindowId: event.paneWindowId,
                panesInWindow: event.panesInWindow,
                charWidth: event.charWidth,
                charHeight: event.charHeight,
                containerWidth: event.containerWidth,
                containerHeight: event.containerHeight,
                containerLeft: event.containerLeft,
                containerTop: event.containerTop,
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
        DRAG_MOVE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (!context.drag) return;

            // Compute centering offset (must match PaneLayout's centering).
            // .pane-layout is inset by CONTAINER_PADDING_X/BOTTOM (CSS), so positions are
            // relative to the content-box. No padding-box arithmetic needed.
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

            // Use cursor position (container-relative) for hit-testing.
            // This correctly handles dragging large panes onto smaller targets,
            // where the pane center would never enter the target's bounds.
            // Up on the tab strip the gesture is a move between tabs, so
            // nothing in the grid should react to it.
            const found = tabStripDrop(context.tabStrip, event.clientX, event.clientY);
            if (found) {
              // Keep the old object while the answer has not changed: the tab
              // strip re-renders on its identity, and a move that stays over
              // the same tab has nothing new to say.
              const tabDrop = sameTabDrop(found, context.drag.tabDrop)
                ? context.drag.tabDrop
                : found;
              enqueue(
                assign({
                  drag: {
                    ...context.drag,
                    targetPaneId: null,
                    tabDrop,
                    currentX: event.clientX,
                    currentY: event.clientY,
                  },
                }),
              );
              enqueue('notifyStateUpdate');
              return;
            }

            const cursorContainerX = event.clientX - context.containerLeft;
            const cursorContainerY = event.clientY - context.containerTop;

            const targetPaneId = findSwapTarget(
              context.panes,
              context.drag.draggedPaneId,
              cursorContainerX,
              cursorContainerY,
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
                enqueue('hapticSwap');
              }
            }

            enqueue(
              assign({
                panes: newPanes,
                drag: {
                  ...context.drag,
                  targetPaneId,
                  tabDrop: null,
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
          actions: enqueueActions(({ context, enqueue }) => {
            // Swaps already happened on hover; a move to another tab is the
            // one thing the release itself decides.
            const drop = context.drag?.tabDrop;
            if (drop && context.drag) {
              const command = tabDropCommand(
                drop,
                context.drag.draggedPaneId,
                context.paneWindowId ?? '',
                context.panesInWindow,
              );
              if (command) {
                enqueue(sendParent({ type: 'SEND_TMUX_COMMAND' as const, command }));
              }
            }
            enqueue(assign({ drag: null }));
            enqueue('notifyStateUpdate');
          }),
        },
      },
    },
  },
});

export type DragMachine = typeof dragMachine;
