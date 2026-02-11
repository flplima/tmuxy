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
import { transformServerState, buildGroupsFromWindows } from './helpers';
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
    groups: {},
    targetCols: DEFAULT_COLS,
    targetRows: DEFAULT_ROWS,
    drag: null,
    resize: null,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    connectionId: null,
    statusLine: '',
    pendingUpdate: null as PendingUpdate | null,
    containerWidth: 0,
    containerHeight: 0,
    lastUpdateTime: 0,
    // Popup state (requires tmux with control mode popup support - PR #4361)
    popup: null,
    // Float pane state
    floatViewVisible: false,
    floatPanes: {},
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

        // If connected but no panes yet, fetch initial state with correct viewport size
        // This handles the race condition where TMUX_CONNECTED fires before SET_TARGET_SIZE
        const needsInitialFetch = context.connected && context.panes.length === 0;
        if (needsInitialFetch) {
          enqueue(
            sendTo('tmux', {
              type: 'FETCH_INITIAL_STATE' as const,
              cols: event.cols,
              rows: event.rows,
            })
          );
        }

        // Only resize if connected and target is smaller than current tmux size
        // This prevents resize loops when multiple clients have different viewports
        const shouldResize =
          context.connected &&
          context.totalWidth > 0 &&
          context.totalHeight > 0 &&
          (event.cols < context.totalWidth || event.rows < context.totalHeight);
        if (shouldResize) {
          const newCols = Math.min(event.cols, context.totalWidth);
          const newRows = Math.min(event.rows, context.totalHeight);
          enqueue(
            sendTo('tmux', {
              type: 'SEND_COMMAND' as const,
              command: `resize-window -x ${newCols} -y ${newRows}`,
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
    STOP_OBSERVE_CONTAINER: {
      actions: sendTo('size', { type: 'STOP_OBSERVE' as const }),
    },
    SET_ANIMATION_ROOT: {
      actions: assign(() => ({})), // Handled by AppContext spawning
    },

    // Connection info events
    CONNECTION_INFO: {
      actions: assign(({ event }) => ({
        connectionId: event.connectionId,
      })),
    },
  },
  states: {
    connecting: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue(assign({ connected: true, error: null }));
            enqueue(sendTo('size', { type: 'CONNECTED' as const }));

            // Only fetch initial state if we already have a computed target size
            // If targetCols/targetRows are still defaults, SET_TARGET_SIZE will trigger the fetch
            const hasComputedSize =
              context.targetCols !== DEFAULT_COLS || context.targetRows !== DEFAULT_ROWS;
            if (hasComputedSize) {
              enqueue(
                sendTo('tmux', {
                  type: 'FETCH_INITIAL_STATE' as const,
                  cols: context.targetCols,
                  rows: context.targetRows,
                })
              );
            }
            // Otherwise, sizeActor will send SET_TARGET_SIZE which triggers FETCH_INITIAL_STATE
          }),
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
              const groups = buildGroupsFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.groups);

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
                    groups,
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
              const groups = buildGroupsFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.groups);

              // Detect new panes for enter animation
              const currentPaneIds = context.panes.map(p => p.tmuxId);
              const newPaneIds = transformed.panes.map(p => p.tmuxId);
              const addedPanes = newPaneIds.filter(id => !currentPaneIds.includes(id));

              enqueue(
                assign({
                  ...transformed,
                  groups,
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

              // If tmux is larger than our target, send a resize command to shrink it
              // Only resize DOWN to prevent loops when multiple clients have different viewports
              const shouldResize =
                context.targetCols > 0 &&
                context.targetRows > 0 &&
                (context.targetCols < transformed.totalWidth || context.targetRows < transformed.totalHeight);
              if (shouldResize) {
                const newCols = Math.min(context.targetCols, transformed.totalWidth);
                const newRows = Math.min(context.targetRows, transformed.totalHeight);
                enqueue(
                  sendTo('tmux', {
                    type: 'SEND_COMMAND' as const,
                    command: `resize-window -x ${newCols} -y ${newRows}`,
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

        // Pane Group Operations
        PANE_GROUP_ADD: {
          actions: sendTo('tmux', ({ context, event }) => {
            const group = context.groups[event.paneId];
            const nextIndex = group ? group.paneIds.length : 1;
            const paneNum = event.paneId.replace('%', '');
            const windowName = `__%${paneNum}_group_${nextIndex}`;
            const windowIndex = 1000 + parseInt(paneNum, 10) * 10 + nextIndex;
            return {
              type: 'SEND_COMMAND' as const,
              command: `new-window -d -t :${windowIndex} -n "${windowName}"`,
            };
          }),
        },
        PANE_GROUP_SWITCH: {
          actions: assign(({ context, event }) => {
            const group = context.groups[event.groupId];
            if (!group) return {};

            const targetIndex = group.paneIds.indexOf(event.paneId);
            if (targetIndex === -1 || targetIndex === group.activeIndex) return {};

            // Update activeIndex to show the selected tab
            return {
              groups: {
                ...context.groups,
                [event.groupId]: {
                  ...group,
                  activeIndex: targetIndex,
                },
              },
            };
          }),
        },
        PANE_GROUP_CLOSE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const group = context.groups[event.groupId];
            if (!group) return;

            const visiblePaneId = group.paneIds[group.activeIndex];
            const isClosingVisible = visiblePaneId === event.paneId;

            // Find which window the pane to close is in
            const paneToClose = context.panes.find((p) => p.tmuxId === event.paneId);
            if (!paneToClose) return;

            const windowWithPane = context.windows.find((w) => w.id === paneToClose.windowId);
            const isInPaneGroupWindow = windowWithPane?.isPaneGroupWindow ?? false;

            if (isClosingVisible && group.paneIds.length > 1) {
              // Closing the visible pane - need to swap another pane into view first
              const currentIdx = group.paneIds.indexOf(event.paneId);
              const nextIdx = currentIdx < group.paneIds.length - 1 ? currentIdx + 1 : currentIdx - 1;
              const nextPaneId = group.paneIds[nextIdx];

              // Find where the next pane is
              const nextPane = context.panes.find((p) => p.tmuxId === nextPaneId);
              const nextWindow = nextPane ? context.windows.find((w) => w.id === nextPane.windowId) : null;
              const nextIsInPaneGroupWindow = nextWindow?.isPaneGroupWindow ?? false;

              if (nextIsInPaneGroupWindow && nextWindow) {
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

            // Closing a non-visible pane or last pane in group
            if (isInPaneGroupWindow && windowWithPane) {
              // Pane is in a pane group window - kill the window
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

        // Float Operations
        TOGGLE_FLOAT_VIEW: {
          actions: assign({
            floatViewVisible: ({ context }) => !context.floatViewVisible,
          }),
        },
        CREATE_FLOAT: {
          actions: enqueueActions(({ context, enqueue }) => {
            // Get next available window index for floats (start at 2000)
            const floatWindows = context.windows.filter((w) => w.isFloatWindow);
            const maxIndex = floatWindows.reduce((max, w) => Math.max(max, w.index), 1999);
            const nextIndex = maxIndex + 1;

            // Create a new window for the float pane
            // The pane number will be assigned by tmux, we use placeholder in name
            // After creation, we'll need to rename based on actual pane ID
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `new-window -d -t :${nextIndex} -n "__float_temp"`,
              })
            );

            // Show float view if not visible
            if (!context.floatViewVisible) {
              enqueue(assign({ floatViewVisible: true }));
            }
          }),
        },
        CONVERT_TO_FLOAT: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const pane = context.panes.find((p) => p.tmuxId === event.paneId);
            if (!pane) return;

            const paneNum = event.paneId.replace('%', '');
            const windowName = `__float_${paneNum}`;

            // Move pane to a new hidden window
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `break-pane -d -t ${event.paneId} -n "${windowName}"`,
              })
            );

            // Rename the window properly (break-pane doesn't support -n properly)
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `rename-window -t ${event.paneId} "${windowName}"`,
              })
            );

            // Initialize float state for this pane
            const floatState = {
              paneId: event.paneId,
              x: 100, // Default position
              y: 100,
              width: Math.min(pane.width * context.charWidth, context.containerWidth - 200),
              height: Math.min(pane.height * context.charHeight, context.containerHeight - 200),
              pinned: false,
            };

            enqueue(
              assign({
                floatPanes: { ...context.floatPanes, [event.paneId]: floatState },
                floatViewVisible: true,
              })
            );
          }),
        },
        EMBED_FLOAT: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const floatWindow = context.windows.find((w) => w.isFloatWindow && w.floatPaneId === event.paneId);
            if (!floatWindow) return;

            // Move float pane back to the active window
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `join-pane -s ${event.paneId} -t ${context.activeWindowId}`,
              })
            );

            // Remove from float panes
            const { [event.paneId]: _, ...remainingFloats } = context.floatPanes;
            enqueue(assign({ floatPanes: remainingFloats }));
          }),
        },
        PIN_FLOAT: {
          actions: assign({
            floatPanes: ({ context, event }) => ({
              ...context.floatPanes,
              [event.paneId]: { ...context.floatPanes[event.paneId], pinned: true },
            }),
          }),
        },
        UNPIN_FLOAT: {
          actions: assign({
            floatPanes: ({ context, event }) => ({
              ...context.floatPanes,
              [event.paneId]: { ...context.floatPanes[event.paneId], pinned: false },
            }),
          }),
        },
        MOVE_FLOAT: {
          actions: assign({
            floatPanes: ({ context, event }) => ({
              ...context.floatPanes,
              [event.paneId]: { ...context.floatPanes[event.paneId], x: event.x, y: event.y },
            }),
          }),
        },
        RESIZE_FLOAT: {
          actions: assign({
            floatPanes: ({ context, event }) => ({
              ...context.floatPanes,
              [event.paneId]: {
                ...context.floatPanes[event.paneId],
                width: event.width,
                height: event.height,
              },
            }),
          }),
        },
        CLOSE_FLOAT: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const floatWindow = context.windows.find((w) => w.isFloatWindow && w.floatPaneId === event.paneId);
            if (floatWindow) {
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `kill-window -t ${floatWindow.id}`,
                })
              );
            }

            // Remove from float panes
            const { [event.paneId]: _, ...remainingFloats } = context.floatPanes;
            enqueue(assign({ floatPanes: remainingFloats }));
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
            const groups = buildGroupsFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId, context.groups);

            enqueue(
              assign({
                pendingUpdate: {
                  ...transformed,
                  groups,
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
