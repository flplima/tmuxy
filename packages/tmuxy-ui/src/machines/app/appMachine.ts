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
  parseCommand,
  calculatePrediction,
  applySplitPrediction,
  applySwapPrediction,
  applyNavigatePrediction,
  reconcileOptimisticUpdate,
} from './optimistic';
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
import { buildSaveGroupsCommand, parseGroupsEnv } from './groupState';
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
    // Optimistic updates (just track the operation for logging/debugging)
    optimisticOperation: null,
    // Dimension override during group switch (prevents intermediate state flicker)
    groupSwitchDimOverride: null,
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

            // Fetch pane groups from tmux environment (for persistence across reloads)
            enqueue(sendTo('tmux', { type: 'FETCH_PANE_GROUPS' as const }));

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
                  // Clear optimistic tracking
                  optimisticOperation: null,
                })
              );
            }),
          },
          {
            // Normal update without pane removal
            actions: enqueueActions(({ event, context, enqueue }) => {
              const transformed = transformServerState(event.state);

              // During group switch: freeze both panes from current context to block
              // intermediate server states. The swap-pane causes TUI apps (nvim) to
              // do a full redraw, producing intermediate frames with inverse-mode on
              // every cell. The freeze blocks these for 500ms. A post-swap resize cycle
              // in PANE_GROUP_SWITCH forces apps to redraw correctly, so the content
              // that arrives after the freeze expires is clean.
              const isGroupSwitching =
                context.groupSwitchDimOverride &&
                Date.now() - context.groupSwitchDimOverride.timestamp < 500;
              if (isGroupSwitching) {
                const { paneId: protectedPaneId, fromPaneId } = context.groupSwitchDimOverride!;
                const currentPanesMap = new Map(context.panes.map(p => [p.tmuxId, p]));
                transformed.panes = transformed.panes.map(p => {
                  if (p.tmuxId === protectedPaneId) {
                    // Fully preserve target pane from current context
                    return currentPanesMap.get(p.tmuxId) ?? p;
                  }
                  if (p.tmuxId === fromPaneId) {
                    // Keep "from" pane in the hidden window so it doesn't appear alongside target
                    const currentFrom = currentPanesMap.get(p.tmuxId);
                    return currentFrom ? { ...p, windowId: currentFrom.windowId } : p;
                  }
                  return p;
                });
                // Preserve activePaneId from optimistic update
                transformed.activePaneId = context.activePaneId;
              }

              // Reconcile optimistic updates if pending
              if (context.optimisticOperation) {
                const result = reconcileOptimisticUpdate(
                  context.optimisticOperation,
                  transformed.panes,
                  transformed.activePaneId
                );

                if (!result.matched && result.mismatchReason) {
                  console.warn('[Optimistic] Rollback:', result.mismatchReason);
                }
              }

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

              // Proactively resize hidden group windows to match visible pane dimensions.
              // This ensures content (especially TUI apps like nvim) is already at the
              // correct size when the user switches tabs, preventing content blinks.
              for (const group of Object.values(paneGroups)) {
                const visiblePaneId = group.paneIds.find(id => {
                  const p = transformed.panes.find(pp => pp.tmuxId === id);
                  return p?.windowId === transformed.activeWindowId;
                });
                if (!visiblePaneId) continue;
                const visiblePane = transformed.panes.find(p => p.tmuxId === visiblePaneId);
                if (!visiblePane) continue;

                for (const paneId of group.paneIds) {
                  if (paneId === visiblePaneId) continue;
                  const pane = transformed.panes.find(p => p.tmuxId === paneId);
                  if (!pane) continue;
                  if (pane.width !== visiblePane.width || pane.height !== visiblePane.height) {
                    enqueue(
                      sendTo('tmux', {
                        type: 'SEND_COMMAND' as const,
                        command: `resize-window -t ${pane.windowId} -x ${visiblePane.width} -y ${visiblePane.height}`,
                      })
                    );
                  }
                }
              }

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
                  // Clear optimistic tracking - server state overwrites any predictions
                  optimisticOperation: null,
                  // Keep group switch override alive for 750ms:
                  // - First 500ms: windowId protection + dimOverride in selector
                  // - 500-750ms: override stays for CSS transition disable in PaneLayout
                  groupSwitchDimOverride:
                    context.groupSwitchDimOverride &&
                    Date.now() - context.groupSwitchDimOverride.timestamp < 750
                      ? context.groupSwitchDimOverride
                      : null,
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
          actions: enqueueActions(({ event, context, enqueue }) => {
            // Don't apply optimistic updates for swap commands during drag
            // The drag machine already handles swaps optimistically
            const isDragging = context.drag !== null;

            // Try to parse and calculate optimistic prediction
            const parsed = parseCommand(event.command);
            const prediction = parsed
              ? calculatePrediction(
                  parsed,
                  context.panes,
                  context.activePaneId,
                  context.activeWindowId,
                  event.command
                )
              : null;

            // Skip optimistic updates for swaps during drag (drag machine handles it)
            const shouldApplyOptimistic = prediction && !(isDragging && prediction.prediction.type === 'swap');

            if (shouldApplyOptimistic && prediction) {
              // Apply optimistic update directly to panes/activePaneId
              // Server state will overwrite when it arrives
              let newPanes = context.panes;
              let newActivePaneId = context.activePaneId;

              switch (prediction.prediction.type) {
                case 'split':
                  newPanes = applySplitPrediction(
                    context.panes,
                    prediction.prediction,
                    context.activeWindowId
                  );
                  // New pane becomes active
                  newActivePaneId = prediction.prediction.newPane.placeholderId;
                  break;
                case 'navigate':
                  newActivePaneId = applyNavigatePrediction(prediction.prediction);
                  break;
                case 'swap':
                  newPanes = applySwapPrediction(context.panes, prediction.prediction);
                  break;
              }

              enqueue(
                assign({
                  optimisticOperation: prediction,
                  panes: newPanes,
                  activePaneId: newActivePaneId,
                })
              );
            }

            // Always send the command to tmux
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: event.command,
              })
            );
          }),
        },
        KEYBINDINGS_RECEIVED: {
          actions: sendTo('keyboard', ({ event }) => ({
            type: 'UPDATE_KEYBINDINGS' as const,
            keybindings: event.keybindings,
          })),
        },
        PANE_GROUPS_LOADED: {
          actions: assign(({ event, context }) => {
            const loadedEnv = parseGroupsEnv(event.groupsJson);
            // Merge loaded groups into paneGroupsEnv
            // Don't overwrite if we already have groups (from this session)
            if (Object.keys(context.paneGroupsEnv.groups).length === 0 &&
                Object.keys(loadedEnv.groups).length > 0) {
              // Rebuild paneGroups using the loaded env
              const paneGroups = buildGroupsFromWindows(
                context.windows,
                context.panes,
                context.activeWindowId,
                context.paneGroups,
                loadedEnv
              );
              return { paneGroupsEnv: loadedEnv, paneGroups };
            }
            return {};
          }),
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
              // After the swap, do a brief resize cycle (-1 col then restore) on the
              // active WINDOW (not pane) to force SIGWINCH on all panes. This makes TUI
              // apps (nvim) redraw properly — without it, swap-pane can leave apps stuck
              // in an intermediate render state (e.g. all cells with inverse mode).
              // The freeze blocks the intermediate content from reaching the UI.
              // Use totalWidth/totalHeight (window dimensions), not pane dimensions.
              const totalW = context.totalWidth;
              const totalH = context.totalHeight;
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `resize-window -t ${targetWindow.id} -x ${visiblePane.width} -y ${visiblePane.height} \\; swap-pane -s ${event.paneId} -t ${currentVisiblePaneId} \\; resize-window -x ${totalW - 1} -y ${totalH} \\; resize-window -x ${totalW} -y ${totalH} \\; ${listPanesCmd}`,
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

            // Optimistic update: swap windowIds and copy position/dimensions
            // so the target pane renders at the correct size immediately,
            // preventing a height flash while waiting for the server state.
            if (visiblePane && targetPane) {
              enqueue(
                assign({
                  panes: context.panes.map(p => {
                    if (p.tmuxId === event.paneId) {
                      return {
                        ...p,
                        windowId: visiblePane.windowId,
                        x: visiblePane.x,
                        y: visiblePane.y,
                        width: visiblePane.width,
                        height: visiblePane.height,
                      };
                    }
                    if (p.tmuxId === currentVisiblePaneId) {
                      return { ...p, windowId: targetPane.windowId };
                    }
                    return p;
                  }),
                  activePaneId: event.paneId,
                  // Lock state so intermediate server states can't override dimensions or content
                  groupSwitchDimOverride: {
                    paneId: event.paneId,
                    fromPaneId: currentVisiblePaneId,
                    x: visiblePane.x,
                    y: visiblePane.y,
                    width: visiblePane.width,
                    height: visiblePane.height,
                    timestamp: Date.now(),
                  },
                })
              );

              // Schedule override clear after 750ms (covers 500ms content freeze + CSS transition buffer)
              // Also schedule a forced state refresh just after the freeze expires to ensure
              // the client gets the correct post-redraw content from the server.
              enqueue(({ self }) => {
                setTimeout(() => {
                  self.send({ type: 'CLEAR_GROUP_SWITCH_OVERRIDE' });
                }, 750);
                setTimeout(() => {
                  self.send({
                    type: 'SEND_COMMAND',
                    command: listPanesCmd,
                  });
                }, 550);
              });
            }
          }),
        },
        PANE_GROUP_PREV: {
          actions: enqueueActions(({ context, enqueue }) => {
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
          actions: enqueueActions(({ context, enqueue }) => {
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

        // Clear group switch override (fired 750ms after PANE_GROUP_SWITCH)
        CLEAR_GROUP_SWITCH_OVERRIDE: {
          actions: assign({ groupSwitchDimOverride: null }),
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
