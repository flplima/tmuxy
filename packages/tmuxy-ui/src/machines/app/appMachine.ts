/**
 * App Machine - Parent orchestrator for the tmuxy application
 *
 * Coordinates:
 * - Actors (fromCallback, injected via factory):
 *   - tmuxActor: WebSocket lifecycle, state updates
 *   - keyboardActor: keydown → formatTmuxKey → send-keys
 *   - sizeActor: window.resize, ResizeObserver, char measurement
 *   - animationActor: anime.js layout, drag transforms, enter/exit (spawned dynamically)
 *
 * - Child Machines (stateful, no DOM access):
 *   - dragMachine: idle/dragging, spawns pointer listener
 *   - resizeMachine: idle/resizing, spawns pointer listener
 */

import { setup, assign, sendTo, enqueueActions, type ActorRefFrom, fromCallback, type AnyActorRef } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents, PendingUpdate } from '../types';
import {
  DEFAULT_SESSION_NAME,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_CHAR_WIDTH,
  DEFAULT_CHAR_HEIGHT,
} from '../constants';
import { transformServerState, buildStacksFromWindows } from './helpers';
import { dragMachine } from '../drag/dragMachine';
import { resizeMachine } from '../resize/resizeMachine';
import type { KeyboardActorEvent } from '../actors/keyboardActor';
import type { TmuxActorEvent } from '../actors/tmuxActor';
import type { SizeActorEvent } from '../actors/sizeActor';

export const appMachine = setup({
  types: {
    context: {} as AppMachineContext,
    events: {} as AllAppMachineEvents,
  },
  actors: {
    tmuxActor: fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(() => () => {}),
    keyboardActor: fromCallback<KeyboardActorEvent, { parent: AnyActorRef }>(() => () => {}),
    sizeActor: fromCallback<SizeActorEvent, { parent: AnyActorRef }>(() => () => {}),
    dragMachine,
    resizeMachine,
  },
}).createMachine({
  id: 'app',
  initial: 'connecting',
  context: {
    connected: false,
    error: null,
    sessionName: DEFAULT_SESSION_NAME,
    activeWindowId: null,
    activePaneId: null,
    panes: [],
    windows: [],
    totalWidth: 0,
    totalHeight: 0,
    stacks: {},
    targetCols: DEFAULT_COLS,
    targetRows: DEFAULT_ROWS,
    drag: null,
    resize: null,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    isPrimary: true,
    connectionId: null,
    statusLine: '',
    pendingUpdate: null as PendingUpdate | null,
    containerWidth: 0,
    containerHeight: 0,
    lastUpdateTime: 0,
    // Popup state (requires tmux with control mode popup support - PR #4361)
    popup: null,
  },
  invoke: [
    {
      id: 'tmux',
      src: 'tmuxActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'size',
      src: 'sizeActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'dragLogic',
      src: 'dragMachine',
    },
    {
      id: 'resizeLogic',
      src: 'resizeMachine',
    },
  ],
  on: {
    // Size events (handled globally, in any state)
    SET_CHAR_SIZE: {
      actions: assign(({ event }) => ({
        charWidth: event.charWidth,
        charHeight: event.charHeight,
      })),
    },
    SET_TARGET_SIZE: {
      actions: enqueueActions(({ event, context, enqueue }) => {
        enqueue(
          assign({
            targetCols: event.cols,
            targetRows: event.rows,
          })
        );
        if (context.isPrimary && context.connected) {
          enqueue(
            sendTo('tmux', {
              type: 'SEND_COMMAND' as const,
              command: `resize-window -x ${event.cols} -y ${event.rows}`,
            })
          );
        }
      }),
    },
    SET_CONTAINER_SIZE: {
      actions: assign(({ event }) => ({
        containerWidth: event.width,
        containerHeight: event.height,
      })),
    },
    OBSERVE_CONTAINER: {
      actions: sendTo('size', ({ event }) => ({
        type: 'OBSERVE_CONTAINER' as const,
        element: event.element,
      })),
    },
    SET_ANIMATION_ROOT: {
      actions: assign(() => ({})), // Handled by AppContext spawning
    },

    // Connection info events (handled globally)
    CONNECTION_INFO: {
      actions: assign(({ event }) => ({
        isPrimary: event.isPrimary,
        connectionId: event.connectionId,
      })),
    },
    PRIMARY_CHANGED: {
      actions: assign(({ event }) => ({
        isPrimary: event.isPrimary,
      })),
    },
  },
  states: {
    connecting: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: [
            assign({ connected: true, error: null }),
            sendTo('size', { type: 'CONNECTED' as const }),
          ],
        },
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
      },
    },

    idle: {
      on: {
        // Tmux Events
        TMUX_STATE_UPDATE: [
          {
            // If panes were removed, transition to removingPane state for exit animation
            guard: ({ event, context }) => {
              const transformed = transformServerState(event.state);
              const currentPaneIds = context.panes.map(p => p.tmuxId);
              const newPaneIds = transformed.panes.map(p => p.tmuxId);
              const removedPanes = currentPaneIds.filter(id => !newPaneIds.includes(id));
              return removedPanes.length > 0;
            },
            target: 'removingPane',
            actions: enqueueActions(({ event, context, enqueue }) => {
              const transformed = transformServerState(event.state);
              const stacks = buildStacksFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.stacks);

              // Find removed panes
              const currentPaneIds = context.panes.map(p => p.tmuxId);
              const newPaneIds = transformed.panes.map(p => p.tmuxId);
              const removedPanes = currentPaneIds.filter(id => !newPaneIds.includes(id));

              // Send leave animation event to animation actor (if spawned)
              enqueue(({ self }) => {
                const snapshot = self.getSnapshot();
                const animRef = snapshot.children?.animation;
                if (animRef) {
                  (animRef as AnyActorRef).send({ type: 'PANES_LEAVING', paneIds: removedPanes });
                }
              });

              // Store the pending update to apply after animation
              enqueue(
                assign({
                  pendingUpdate: {
                    ...transformed,
                    stacks,
                  },
                  lastUpdateTime: Date.now(),
                })
              );
            }),
          },
          {
            // Normal update without pane removal
            actions: enqueueActions(({ event, context, enqueue }) => {
              const transformed = transformServerState(event.state);
              const stacks = buildStacksFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.stacks);

              // Detect new panes for enter animation
              const currentPaneIds = context.panes.map(p => p.tmuxId);
              const newPaneIds = transformed.panes.map(p => p.tmuxId);
              const addedPanes = newPaneIds.filter(id => !currentPaneIds.includes(id));

              enqueue(
                assign({
                  ...transformed,
                  stacks,
                  lastUpdateTime: Date.now(),
                })
              );
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_SESSION' as const,
                  sessionName: transformed.sessionName,
                })
              );

              // Trigger enter animation for new panes
              if (addedPanes.length > 0 && currentPaneIds.length > 0) {
                enqueue(({ self }) => {
                  const snapshot = self.getSnapshot();
                  const animRef = snapshot.children?.animation;
                  if (animRef) {
                    (animRef as AnyActorRef).send({ type: 'PANES_ENTERING', paneIds: addedPanes });
                  }
                });
              }

              // If tmux dimensions don't match our target, send a resize command
              if (
                context.isPrimary &&
                context.targetCols > 0 &&
                context.targetRows > 0 &&
                (transformed.totalWidth !== context.targetCols || transformed.totalHeight !== context.targetRows)
              ) {
                enqueue(
                  sendTo('tmux', {
                    type: 'SEND_COMMAND' as const,
                    command: `resize-window -x ${context.targetCols} -y ${context.targetRows}`,
                  })
                );
              }
            }),
          },
        ],
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
        TMUX_DISCONNECTED: {
          target: 'connecting',
          actions: assign({ connected: false }),
        },

        // Keyboard actor events
        SEND_TMUX_COMMAND: {
          actions: sendTo('tmux', ({ event }) => ({
            type: 'SEND_COMMAND' as const,
            command: event.command,
          })),
        },

        // Drag Events - Forward to drag machine with full context
        DRAG_START: {
          actions: [
            assign(({ event, context }) => {
              const pane = context.panes.find(p => p.tmuxId === event.paneId);
              return {
                drag: {
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
                },
              };
            }),
            sendTo('dragLogic', ({ event, context }) => ({
              ...event,
              panes: context.panes,
              activePaneId: context.activePaneId,
              charWidth: context.charWidth,
              charHeight: context.charHeight,
              containerWidth: context.containerWidth,
              containerHeight: context.containerHeight,
            })),
          ],
        },
        DRAG_MOVE: {
          actions: sendTo('dragLogic', ({ event }) => event),
        },
        DRAG_END: {
          actions: sendTo('dragLogic', { type: 'DRAG_END' }),
        },
        DRAG_CANCEL: {
          actions: sendTo('dragLogic', { type: 'DRAG_CANCEL' }),
        },

        // Events from Drag Machine
        DRAG_STATE_UPDATE: {
          actions: assign(({ event }) => ({
            drag: event.drag,
          })),
        },
        DRAG_COMPLETED: {},
        DRAG_ERROR: {
          actions: assign(({ event }) => ({ error: event.error, drag: null })),
        },

        // Resize Events - Forward to resize machine with full context
        RESIZE_START: {
          actions: sendTo('resizeLogic', ({ event, context }) => ({
            ...event,
            panes: context.panes,
            charWidth: context.charWidth,
            charHeight: context.charHeight,
          })),
        },
        RESIZE_MOVE: {
          actions: sendTo('resizeLogic', ({ event }) => event),
        },
        RESIZE_END: {
          actions: sendTo('resizeLogic', { type: 'RESIZE_END' }),
        },
        RESIZE_CANCEL: {
          actions: sendTo('resizeLogic', { type: 'RESIZE_CANCEL' }),
        },

        // Forward KEY_PRESS to drag and resize machines for Escape handling
        KEY_PRESS: {
          actions: [
            sendTo('dragLogic', ({ event }) => event),
            sendTo('resizeLogic', ({ event }) => event),
          ],
        },

        // Events from Resize Machine
        RESIZE_STATE_UPDATE: {
          actions: assign(({ event }) => ({
            resize: event.resize,
          })),
        },
        RESIZE_COMPLETED: {
          actions: assign({ resize: null }),
        },
        RESIZE_ERROR: {
          actions: assign(({ event }) => ({ error: event.error, resize: null })),
        },

        // Animation events
        ANIMATION_LEAVE_COMPLETE: {},
        ANIMATION_DRAG_COMPLETE: {},

        // Pane Operations
        FOCUS_PANE: {
          actions: sendTo('tmux', ({ event }) => ({
            type: 'SEND_COMMAND' as const,
            command: `select-pane -t ${event.paneId}`,
          })),
        },
        SEND_COMMAND: {
          actions: sendTo('tmux', ({ event }) => ({
            type: 'SEND_COMMAND' as const,
            command: event.command,
          })),
        },

        // Stack Operations
        STACK_ADD_PANE: {
          actions: sendTo('tmux', ({ context, event }) => {
            const stack = context.stacks[event.paneId];
            const nextIndex = stack ? stack.paneIds.length : 1;
            const paneNum = event.paneId.replace('%', '');
            const windowName = `__%${paneNum}_stack_${nextIndex}`;
            const windowIndex = 1000 + parseInt(paneNum, 10) * 10 + nextIndex;
            return {
              type: 'SEND_COMMAND' as const,
              command: `new-window -d -t :${windowIndex} -n "${windowName}"`,
            };
          }),
        },
        STACK_SWITCH: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const stack = context.stacks[event.stackId];
            if (!stack) return;

            const currentPaneId = stack.paneIds[stack.activeIndex];
            const targetPaneId = event.paneId;

            if (currentPaneId === targetPaneId) return;

            // Verify target pane exists and is part of this stack
            const targetPane = context.panes.find((p) => p.tmuxId === targetPaneId);
            if (!targetPane || !stack.paneIds.includes(targetPaneId)) return;

            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `swap-pane -s ${currentPaneId} -t ${targetPaneId}`,
              })
            );
          }),
        },
        STACK_CLOSE_PANE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const stack = context.stacks[event.stackId];
            if (!stack) return;

            const visiblePaneId = stack.paneIds[stack.activeIndex];
            const isClosingVisible = visiblePaneId === event.paneId;

            // Find which window the pane to close is in
            const paneToClose = context.panes.find((p) => p.tmuxId === event.paneId);
            if (!paneToClose) return;

            const windowWithPane = context.windows.find((w) => w.id === paneToClose.windowId);
            const isInStackWindow = windowWithPane?.isStackWindow ?? false;

            if (isClosingVisible && stack.paneIds.length > 1) {
              // Closing the visible pane - need to swap another pane into view first
              const currentIdx = stack.paneIds.indexOf(event.paneId);
              const nextIdx = currentIdx < stack.paneIds.length - 1 ? currentIdx + 1 : currentIdx - 1;
              const nextPaneId = stack.paneIds[nextIdx];

              // Find where the next pane is
              const nextPane = context.panes.find((p) => p.tmuxId === nextPaneId);
              const nextWindow = nextPane ? context.windows.find((w) => w.id === nextPane.windowId) : null;
              const nextIsInStackWindow = nextWindow?.isStackWindow ?? false;

              if (nextIsInStackWindow && nextWindow) {
                // Swap the visible pane with next, then kill the now-hidden window
                enqueue(
                  sendTo('tmux', {
                    type: 'SEND_COMMAND' as const,
                    command: `swap-pane -s ${event.paneId} -t ${nextPaneId} \\; kill-window -t ${nextWindow.id}`,
                  })
                );
                return;
              }
            }

            // Closing a non-visible pane or last pane in stack
            if (isInStackWindow && windowWithPane) {
              // Pane is in a stack window - kill the window
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `kill-window -t ${windowWithPane.id}`,
                })
              );
              return;
            }

            // Pane is in main window - just kill the pane
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `kill-pane -t ${event.paneId}`,
              })
            );
          }),
        },
      },
    },

    removingPane: {
      on: {
        ANIMATION_LEAVE_COMPLETE: {
          target: 'idle',
          actions: enqueueActions(({ context, enqueue }) => {
            if (!context.pendingUpdate) return;

            const update = context.pendingUpdate;

            enqueue(
              assign({
                ...update,
                pendingUpdate: null,
              })
            );
            enqueue(
              sendTo('keyboard', {
                type: 'UPDATE_SESSION' as const,
                sessionName: update.sessionName,
              })
            );
          }),
        },
        // Queue any new state updates that arrive during animation
        TMUX_STATE_UPDATE: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            const transformed = transformServerState(event.state);
            const stacks = buildStacksFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.stacks);

            enqueue(
              assign({
                pendingUpdate: {
                  ...transformed,
                  stacks,
                },
                lastUpdateTime: Date.now(),
              })
            );
          }),
        },
        // Still handle tmux commands during animation
        SEND_TMUX_COMMAND: {
          actions: sendTo('tmux', ({ event }) => ({
            type: 'SEND_COMMAND' as const,
            command: event.command,
          })),
        },
        SEND_COMMAND: {
          actions: sendTo('tmux', ({ event }) => ({
            type: 'SEND_COMMAND' as const,
            command: event.command,
          })),
        },
        KEY_PRESS: {
          actions: [
            sendTo('dragLogic', ({ event }) => event),
            sendTo('resizeLogic', ({ event }) => event),
          ],
        },
        // Still handle errors and disconnects
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
        TMUX_DISCONNECTED: {
          target: 'connecting',
          actions: assign({ connected: false, pendingUpdate: null }),
        },
      },
    },
  },
});

export type AppMachine = typeof appMachine;
export type AppMachineActor = ActorRefFrom<typeof appMachine>;
