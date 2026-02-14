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
import {
  transformServerState,
  buildGroupsFromWindows,
  buildFloatPanesFromWindows,
  findGroupForPane,
  createNewGroup,
  reconcileGroupsWithPanes,
  makeGroupWindowName,
  type TmuxyGroupsEnv,
} from './helpers';
import { buildSaveGroupsCommand } from './groupState';
import type { TmuxWindow } from '../types';

/**
 * Find a float window by pane ID.
 * Float windows have the pattern: __float_{pane_num}
 * Example: __float_5 for pane %5
 */
function findFloatWindowByPaneId(windows: TmuxWindow[], paneId: string): TmuxWindow | undefined {
  const paneNum = paneId.replace('%', '');
  const floatWindowName = `__float_${paneNum}`;
  return windows.find((w) => w.isFloatWindow && w.name === floatWindowName);
}
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
    paneGroups: {},
    paneGroupsEnv: { version: 1, groups: {} } as TmuxyGroupsEnv,
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
    // Float pane state
    floatViewVisible: false,
    floatPanes: {},
    // Animation settings
    enableAnimations: true,
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

              // Reconcile paneGroupsEnv with current panes (remove references to deleted panes)
              const { env: reconciledPaneGroupsEnv, changed: paneGroupsEnvChanged, saveCommand: reconcileSaveCmd } =
                reconcileGroupsWithPanes(context.paneGroupsEnv, transformed.panes.map(p => p.tmuxId));

              const paneGroups = buildGroupsFromWindows(
                transformed.windows,
                transformed.panes,
                transformed.activeWindowId,
                context.paneGroups,
                reconciledPaneGroupsEnv
              );

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

              // Build float panes from windows with __float_ naming pattern
              const floatPanes = buildFloatPanesFromWindows(
                transformed.windows,
                transformed.panes,
                context.floatPanes,
                context.containerWidth,
                context.containerHeight,
                context.charWidth,
                context.charHeight
              );

              // If paneGroupsEnv changed, save to tmux environment
              if (paneGroupsEnvChanged && reconcileSaveCmd) {
                enqueue(
                  sendTo('tmux', {
                    type: 'SEND_COMMAND' as const,
                    command: reconcileSaveCmd,
                  })
                );
              }

              // Store the pending update to apply after animation
              enqueue(
                assign({
                  pendingUpdate: {
                    ...transformed,
                    paneGroups,
                    floatPanes,
                  },
                  paneGroupsEnv: reconciledPaneGroupsEnv,
                  lastUpdateTime: Date.now(),
                })
              );
            }),
          },
          {
            // Normal update without pane removal
            actions: enqueueActions(({ event, context, enqueue }) => {
              const transformed = transformServerState(event.state);

              // Build pane groups using paneGroupsEnv as source of truth for UUID-based groups
              const paneGroups = buildGroupsFromWindows(
                transformed.windows,
                transformed.panes,
                transformed.activeWindowId,
                context.paneGroups,
                context.paneGroupsEnv
              );

              // Build float panes from windows with __float_ naming pattern
              const floatPanes = buildFloatPanesFromWindows(
                transformed.windows,
                transformed.panes,
                context.floatPanes,
                context.containerWidth,
                context.containerHeight,
                context.charWidth,
                context.charHeight
              );

              // Detect new panes for enter animation
              const currentPaneIds = context.panes.map(p => p.tmuxId);
              const newPaneIds = transformed.panes.map(p => p.tmuxId);
              const addedPanes = newPaneIds.filter(id => !currentPaneIds.includes(id));

              // Update paneGroupsEnv if new panes were discovered in group windows
              let updatedPaneGroupsEnv = context.paneGroupsEnv;
              if (addedPanes.length > 0) {
                // Check if any added panes are in UUID-based group windows
                for (const paneId of addedPanes) {
                  const pane = transformed.panes.find(p => p.tmuxId === paneId);
                  if (!pane) continue;

                  const window = transformed.windows.find(w => w.id === pane.windowId);
                  if (!window) continue;

                  // Check for UUID-based window naming: __group_{uuid}_{index}
                  const match = window.name.match(/^__group_([a-z0-9_]+)_(\d+)$/);
                  if (match) {
                    const groupId = match[1];
                    const existingGroup = updatedPaneGroupsEnv.groups[groupId];

                    if (existingGroup) {
                      // Add new pane to existing group
                      if (!existingGroup.paneIds.includes(paneId)) {
                        updatedPaneGroupsEnv = {
                          ...updatedPaneGroupsEnv,
                          groups: {
                            ...updatedPaneGroupsEnv.groups,
                            [groupId]: {
                              ...existingGroup,
                              paneIds: [...existingGroup.paneIds, paneId],
                            },
                          },
                        };
                      }
                    } else {
                      // Create new group with this pane and the active pane
                      // The active pane should be the one that triggered PANE_GROUP_ADD
                      const activePaneId = context.activePaneId;
                      if (activePaneId && activePaneId !== paneId) {
                        updatedPaneGroupsEnv = {
                          ...updatedPaneGroupsEnv,
                          groups: {
                            ...updatedPaneGroupsEnv.groups,
                            [groupId]: {
                              id: groupId,
                              paneIds: [activePaneId, paneId],
                            },
                          },
                        };
                      }
                    }
                  }
                }

                // Save updated paneGroupsEnv to tmux environment if changed
                if (updatedPaneGroupsEnv !== context.paneGroupsEnv) {
                  enqueue(
                    sendTo('tmux', {
                      type: 'SEND_COMMAND' as const,
                      command: buildSaveGroupsCommand(updatedPaneGroupsEnv),
                    })
                  );
                }
              }

              enqueue(
                assign({
                  ...transformed,
                  paneGroups,
                  paneGroupsEnv: updatedPaneGroupsEnv,
                  floatPanes,
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
        KEYBINDINGS_RECEIVED: {
          actions: sendTo('keyboard', ({ event }) => ({
            type: 'UPDATE_KEYBINDINGS' as const,
            keybindings: event.keybindings,
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
          actions: enqueueActions(({ context, event, enqueue }) => {
            const activePaneId = event.paneId;

            // Check if the active pane is already in a group
            const existingGroup = findGroupForPane(context.paneGroupsEnv, activePaneId);

            let groupId: string;
            let nextIndex: number;

            if (existingGroup) {
              // Add to existing group - use existing group ID
              groupId = existingGroup.id;
              nextIndex = existingGroup.paneIds.length;
            } else {
              // Create a new group - generate UUID for the window name
              // The actual paneGroupsEnv will be updated when we receive the TMUX_STATE_UPDATE
              // with the new pane ID from the window we just created
              const result = createNewGroup(context.paneGroupsEnv, activePaneId, '');
              groupId = result.groupId;
              nextIndex = 1;
            }

            // Use UUID-based window naming: __group_{groupId}_{index}
            const windowName = makeGroupWindowName(groupId, nextIndex);

            // Use a high window index to keep group windows out of the way
            // Hash the groupId to get a stable window index
            const groupHash = groupId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
            const windowIndex = 1000 + (groupHash % 1000) * 10 + nextIndex;

            // Get the parent pane's dimensions to size the hidden window correctly
            const parentPane = context.panes.find((p) => p.tmuxId === activePaneId);
            const paneWidth = parentPane?.width ?? context.totalWidth;
            const paneHeight = parentPane?.height ?? context.totalHeight;

            // Create the hidden window and resize it to match parent pane dimensions
            // The new pane stays in the hidden window - user clicks the tab to switch
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `new-window -d -t :${windowIndex} -n "${windowName}" \\; resize-window -t :${windowIndex} -x ${paneWidth} -y ${paneHeight}`,
              })
            );

            // Force state sync after window creation to ensure the new pane appears
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}'`,
              })
            );
          }),
        },
        PANE_GROUP_SWITCH: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const group = context.paneGroups[event.groupId];
            if (!group) return;

            // Find the currently visible pane (the one in the active window)
            const currentVisiblePaneId = group.paneIds.find((paneId) => {
              const pane = context.panes.find((p) => p.tmuxId === paneId);
              return pane?.windowId === context.activeWindowId;
            });

            // Don't switch if target is already visible or not in group
            if (!currentVisiblePaneId || currentVisiblePaneId === event.paneId) return;
            if (!group.paneIds.includes(event.paneId)) return;

            // Get the visible pane's current dimensions
            const visiblePane = context.panes.find((p) => p.tmuxId === currentVisiblePaneId);
            const targetPane = context.panes.find((p) => p.tmuxId === event.paneId);

            // Find the window containing the target pane (hidden window)
            const targetWindow = context.windows.find((w) => w.id === targetPane?.windowId);

            // Resize the hidden window and swap in a single chained command
            // This ensures proper sequencing: resize happens before swap
            // Also chain list-panes to refresh pane-window mappings after swap
            const listPanesCmd = `list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}'`;

            if (visiblePane && targetWindow) {
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `resize-window -t ${targetWindow.id} -x ${visiblePane.width} -y ${visiblePane.height} \\; swap-pane -s ${event.paneId} -t ${currentVisiblePaneId} \\; ${listPanesCmd}`,
                })
              );
            } else {
              // Fallback: just swap without resize
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `swap-pane -s ${event.paneId} -t ${currentVisiblePaneId} \\; ${listPanesCmd}`,
                })
              );
            }
            // No optimistic update - UI will update when tmux state arrives
          }),
        },
        PANE_GROUP_PREV: {
          actions: enqueueActions(({ context, enqueue, self }) => {
            // Find the group containing the active pane
            const activePaneId = context.activePaneId;
            if (!activePaneId) return;

            const groupEntry = Object.entries(context.paneGroups).find(([, group]) =>
              group.paneIds.includes(activePaneId)
            );
            if (!groupEntry) return;

            const [groupId, group] = groupEntry;
            if (group.paneIds.length <= 1) return;

            // Find the currently visible pane in the group
            const visiblePaneId = group.paneIds.find((paneId) => {
              const pane = context.panes.find((p) => p.tmuxId === paneId);
              return pane?.windowId === context.activeWindowId;
            });
            if (!visiblePaneId) return;

            // Get the previous pane (wrap around)
            const currentIdx = group.paneIds.indexOf(visiblePaneId);
            const prevIdx = currentIdx > 0 ? currentIdx - 1 : group.paneIds.length - 1;
            const prevPaneId = group.paneIds[prevIdx];

            if (prevPaneId !== visiblePaneId) {
              // Reuse PANE_GROUP_SWITCH logic by sending the event to self
              enqueue.raise({ type: 'PANE_GROUP_SWITCH', groupId, paneId: prevPaneId });
            }
          }),
        },
        PANE_GROUP_NEXT: {
          actions: enqueueActions(({ context, enqueue, self }) => {
            // Find the group containing the active pane
            const activePaneId = context.activePaneId;
            if (!activePaneId) return;

            const groupEntry = Object.entries(context.paneGroups).find(([, group]) =>
              group.paneIds.includes(activePaneId)
            );
            if (!groupEntry) return;

            const [groupId, group] = groupEntry;
            if (group.paneIds.length <= 1) return;

            // Find the currently visible pane in the group
            const visiblePaneId = group.paneIds.find((paneId) => {
              const pane = context.panes.find((p) => p.tmuxId === paneId);
              return pane?.windowId === context.activeWindowId;
            });
            if (!visiblePaneId) return;

            // Get the next pane (wrap around)
            const currentIdx = group.paneIds.indexOf(visiblePaneId);
            const nextIdx = currentIdx < group.paneIds.length - 1 ? currentIdx + 1 : 0;
            const nextPaneId = group.paneIds[nextIdx];

            if (nextPaneId !== visiblePaneId) {
              // Reuse PANE_GROUP_SWITCH logic by sending the event to self
              enqueue.raise({ type: 'PANE_GROUP_SWITCH', groupId, paneId: nextPaneId });
            }
          }),
        },
        PANE_GROUP_CLOSE: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const group = context.paneGroups[event.groupId];
            if (!group) return;

            // Find the currently visible pane (the one in the active window)
            const visiblePaneId = group.paneIds.find((paneId) => {
              const pane = context.panes.find((p) => p.tmuxId === paneId);
              return pane?.windowId === context.activeWindowId;
            });
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
                // Force state sync after the swap/kill
                enqueue(
                  sendTo('tmux', {
                    type: 'SEND_COMMAND' as const,
                    command: `list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}'`,
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
              // Force state sync after a delay to ensure the window is killed
              // The periodic sync should handle this, but we add a backup
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}'`,
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
            const floatWindow = findFloatWindowByPaneId(context.windows, event.paneId);
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
            const floatWindow = findFloatWindowByPaneId(context.windows, event.paneId);
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
      // Fallback timeout: if animation doesn't complete (e.g., no animation actor),
      // auto-transition to idle after 300ms
      after: {
        300: {
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
      },
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

            // Reconcile paneGroupsEnv with current panes
            const { env: reconciledPaneGroupsEnv } =
              reconcileGroupsWithPanes(context.paneGroupsEnv, transformed.panes.map(p => p.tmuxId));

            const paneGroups = buildGroupsFromWindows(
              transformed.windows,
              transformed.panes,
              transformed.activeWindowId,
              context.paneGroups,
              reconciledPaneGroupsEnv
            );
            const floatPanes = buildFloatPanesFromWindows(
              transformed.windows,
              transformed.panes,
              context.floatPanes,
              context.containerWidth,
              context.containerHeight,
              context.charWidth,
              context.charHeight
            );

            enqueue(
              assign({
                pendingUpdate: {
                  ...transformed,
                  paneGroups,
                  floatPanes,
                },
                paneGroupsEnv: reconciledPaneGroupsEnv,
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
        KEYBINDINGS_RECEIVED: {
          actions: sendTo('keyboard', ({ event }) => ({
            type: 'UPDATE_KEYBINDINGS' as const,
            keybindings: event.keybindings,
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
