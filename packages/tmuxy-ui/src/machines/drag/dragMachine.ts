/**
 * Drag Machine - Handles pane drag-to-swap operations
 *
 * Sends real-time swap commands once the pointer rests on another pane.
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
 * Over a pane header the gesture is about pane groups (see utils/groupDrop):
 * a member moves along its group's order, an ungrouped pane joins the group
 * of the header it is dropped on, and a parked member dragged out by its tab
 * leaves the group. These also wait for the release.
 *
 * States:
 * - idle: No drag in progress
 * - dragging: Pane is being dragged, swaps happen on target change
 */

import { setup, assign, sendParent, enqueueActions, fromCallback, raise, cancel } from 'xstate';
import type { DragMachineContext, DragMachineEvent, DragState, KeyPressEvent } from '../types';
import { DEFAULT_CHAR_WIDTH, DEFAULT_CHAR_HEIGHT } from '../constants';
import { findSwapTarget } from './helpers';
import { tabStripDrop, tabDropOp, sameTabDrop } from '../../utils/tabStripDrop';
import {
  groupDropAt,
  groupDropOp,
  groupOf,
  headerBands,
  leaveOp,
  sameGroupDrop,
  sideOf,
} from '../../utils/groupDrop';
import { paneInsetX } from '../../constants';
import { TmuxOp } from '../../domain/commands';
import { haptics } from '../../utils/haptics';

/** How long the pointer rests on a pane before the dragged pane swaps with it. */
export const SWAP_DWELL_MS = 250;
const SWAP_DWELL_ID = 'swap-dwell';

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
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    containerWidth: 0,
    containerHeight: 0,
    containerLeft: 0,
    containerTop: 0,
    tabStrip: null,
    paneWindowId: null,
    panesInWindow: 0,
    groups: {},
    pendingSwap: null,
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
                groupDrop: null,
                memberDrag: event.memberDrag,
                leaveSide: null,
              };
              return {
                drag,
                pendingSwap: null,
                panes: event.panes,
                groups: event.groups,
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
                    groupDrop: null,
                    leaveSide: null,
                    currentX: event.clientX,
                    currentY: event.clientY,
                  },
                }),
              );
              enqueue(cancel(SWAP_DWELL_ID));
              enqueue(assign({ pendingSwap: null }));
              enqueue('notifyStateUpdate');
              return;
            }

            const cursorContainerX = event.clientX - context.containerLeft;
            const cursorContainerY = event.clientY - context.containerTop;

            // Over a header the gesture is about the group, and nothing swaps.
            const draggedId = context.drag.draggedPaneId;
            const foundGroupDrop = groupDropAt(
              headerBands(
                context.panes,
                context.groups,
                context.charWidth,
                context.charHeight,
                centerOffsetX,
                centerOffsetY,
              ),
              draggedId,
              groupOf(context.groups, draggedId) !== null,
              cursorContainerX,
              cursorContainerY,
            );
            if (foundGroupDrop) {
              const groupDrop = sameGroupDrop(foundGroupDrop, context.drag.groupDrop)
                ? context.drag.groupDrop
                : foundGroupDrop;
              enqueue(
                assign({
                  drag: {
                    ...context.drag,
                    targetPaneId: null,
                    tabDrop: null,
                    groupDrop,
                    leaveSide: null,
                    currentX: event.clientX,
                    currentY: event.clientY,
                  },
                }),
              );
              enqueue(cancel(SWAP_DWELL_ID));
              enqueue(assign({ pendingSwap: null }));
              enqueue('notifyStateUpdate');
              return;
            }

            // A parked member is not on screen to swap: the pane under the
            // pointer is where it would leave its group to, beside it.
            if (context.drag.memberDrag) {
              const target = findSwapTarget(
                context.panes,
                draggedId,
                cursorContainerX,
                cursorContainerY,
                context.charWidth,
                context.charHeight,
                centerOffsetX,
                centerOffsetY,
              );
              const pane = context.panes.find((p) => p.tmuxId === target);
              const insetX = paneInsetX(context.charWidth);
              const leaveSide = pane
                ? sideOf(
                    {
                      left: centerOffsetX + pane.x * context.charWidth - insetX,
                      top: centerOffsetY + pane.y * context.charHeight,
                      right: centerOffsetX + (pane.x + pane.width) * context.charWidth + insetX,
                      bottom: centerOffsetY + (pane.y + pane.height) * context.charHeight,
                    },
                    cursorContainerX,
                    cursorContainerY,
                  )
                : null;
              enqueue(
                assign({
                  drag: {
                    ...context.drag,
                    targetPaneId: pane ? pane.tmuxId : null,
                    tabDrop: null,
                    groupDrop: null,
                    leaveSide,
                    currentX: event.clientX,
                    currentY: event.clientY,
                    ghostX: pane?.x ?? context.drag.ghostX,
                    ghostY: pane?.y ?? context.drag.ghostY,
                    ghostWidth: pane?.width ?? context.drag.ghostWidth,
                    ghostHeight: pane?.height ?? context.drag.ghostHeight,
                  },
                }),
              );
              enqueue(cancel(SWAP_DWELL_ID));
              enqueue(assign({ pendingSwap: null }));
              enqueue('notifyStateUpdate');
              return;
            }

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

            // A pane swaps once the pointer has rested on it for a moment: one
            // the pointer only crosses — on its way to a header above it, say
            // — must not trade places, or the header it was heading for would
            // move out from under it.
            if (targetPaneId !== null && targetPaneId !== context.drag.targetPaneId) {
              if (targetPaneId !== context.pendingSwap) {
                enqueue(cancel(SWAP_DWELL_ID));
                enqueue(
                  raise(
                    { type: 'SWAP_DWELL' as const, paneId: targetPaneId },
                    {
                      delay: SWAP_DWELL_MS,
                      id: SWAP_DWELL_ID,
                    },
                  ),
                );
              }
            } else {
              enqueue(cancel(SWAP_DWELL_ID));
            }

            enqueue(
              assign({
                pendingSwap: targetPaneId !== context.drag.targetPaneId ? targetPaneId : null,
                drag: {
                  ...context.drag,
                  // Off every pane, the pane it last swapped with may be
                  // swapped with again when the pointer comes back.
                  targetPaneId: targetPaneId === null ? null : context.drag.targetPaneId,
                  tabDrop: null,
                  groupDrop: null,
                  currentX: event.clientX,
                  currentY: event.clientY,
                },
              }),
            );

            enqueue('notifyStateUpdate');
          }),
        },
        SWAP_DWELL: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const drag = context.drag;
            if (!drag || context.pendingSwap !== event.paneId) return;
            const targetPane = context.panes.find((p) => p.tmuxId === event.paneId);
            const draggedPane = context.panes.find((p) => p.tmuxId === drag.draggedPaneId);
            if (!targetPane || !draggedPane) return;

            // Optimistic swap: update local pane positions for accurate hit testing
            const box = (p: { x: number; y: number; width: number; height: number }) => ({
              x: p.x,
              y: p.y,
              width: p.width,
              height: p.height,
            });
            const panes = context.panes.map((p) => {
              if (p.tmuxId === drag.draggedPaneId) return { ...p, ...box(targetPane) };
              if (p.tmuxId === targetPane.tmuxId) return { ...p, ...box(draggedPane) };
              return p;
            });
            enqueue(
              sendParent({
                type: 'DISPATCH_OP' as const,
                op: TmuxOp.Swap({
                  sourcePaneId: drag.draggedPaneId,
                  targetPaneId: targetPane.tmuxId,
                  keepFocus: true,
                }),
              }),
            );
            enqueue('hapticSwap');
            enqueue(
              assign({
                panes,
                pendingSwap: null,
                drag: {
                  ...drag,
                  targetPaneId: targetPane.tmuxId,
                  // The ghost marks where the dragged pane now sits.
                  ghostX: targetPane.x,
                  ghostY: targetPane.y,
                  ghostWidth: targetPane.width,
                  ghostHeight: targetPane.height,
                },
              }),
            );
            enqueue('notifyStateUpdate');
          }),
        },
        DRAG_END: {
          target: 'idle',
          actions: enqueueActions(({ context, enqueue }) => {
            // Swaps already happened on hover; a move to another tab or a
            // group change is what the release itself decides.
            const drag = context.drag;
            let op: TmuxOp | null = null;
            if (drag?.groupDrop) {
              op = groupDropOp(drag.groupDrop, drag.draggedPaneId);
            } else if (drag?.memberDrag && drag.tabDrop) {
              op = leaveOp(drag.draggedPaneId, drag.tabDrop);
            } else if (drag?.memberDrag && drag.targetPaneId && drag.leaveSide) {
              op = leaveOp(drag.draggedPaneId, {
                kind: 'beside',
                paneId: drag.targetPaneId,
                side: drag.leaveSide,
              });
            } else if (drag?.tabDrop) {
              op = tabDropOp(
                drag.tabDrop,
                drag.draggedPaneId,
                context.paneWindowId,
                context.panesInWindow,
              );
            }
            if (op) enqueue(sendParent({ type: 'DISPATCH_OP' as const, op }));
            enqueue(cancel(SWAP_DWELL_ID));
            enqueue(assign({ drag: null }));
            enqueue('notifyStateUpdate');
          }),
        },
      },
    },
  },
});

export type DragMachine = typeof dragMachine;
