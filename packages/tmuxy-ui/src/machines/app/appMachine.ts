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
  reconcileGroupsWithPanes,
  type TmuxyGroupsEnv,
} from './helpers';
import { parseGroupsEnv, parseGroupWindowName } from './groupState';

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

        // Notify server of viewport size change so it can set the control mode
        // client size (refresh-client -C). This works with window-size smallest.
        const shouldResize =
          context.connected &&
          context.totalWidth > 0 &&
          (event.cols !== context.totalWidth || event.rows !== context.totalHeight);
        if (shouldResize) {
          enqueue(
            sendTo('tmux', {
              type: 'INVOKE' as const,
              cmd: 'set_client_size',
              args: { cols: event.cols, rows: event.rows },
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

              // Detect new group windows not yet in paneGroupsEnv and re-fetch
              const hasNewGroupWindows = transformed.windows.some(w => {
                const match = parseGroupWindowName(w.name);
                return match && !reconciledPaneGroupsEnv.groups[match.groupId];
              });
              if (hasNewGroupWindows) {
                enqueue(sendTo('tmux', { type: 'FETCH_PANE_GROUPS' as const }));
              }

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
              // every cell. The freeze blocks these for 500ms. A delayed list-panes
              // at 550ms forces a state refresh so correct content arrives after unfreeze.
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

              // Detect new group windows not yet in paneGroupsEnv and re-fetch
              const hasNewGroupWindows = transformed.windows.some(w => {
                const match = parseGroupWindowName(w.name);
                return match && !context.paneGroupsEnv.groups[match.groupId];
              });
              if (hasNewGroupWindows) {
                enqueue(sendTo('tmux', { type: 'FETCH_PANE_GROUPS' as const }));
              }

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

              // Detect group switch reactively: when a TMUX_STATE_UPDATE shows a different
              // visible pane in a group vs the previous state, set the dim override.
              // This preserves the 500ms content freeze without needing a client-side switch handler.
              let groupSwitchOverride = context.groupSwitchDimOverride;
              if (!groupSwitchOverride) {
                for (const group of Object.values(paneGroups)) {
                  // Find visible pane in new state (in active window)
                  const newVisibleId = group.paneIds.find(id => {
                    const p = transformed.panes.find(pp => pp.tmuxId === id);
                    return p?.windowId === transformed.activeWindowId;
                  });
                  // Find visible pane in previous state
                  const prevGroup = context.paneGroups[group.id];
                  const prevVisibleId = prevGroup?.paneIds.find(id => {
                    const p = context.panes.find(pp => pp.tmuxId === id);
                    return p?.windowId === context.activeWindowId;
                  });
                  // If different and both exist, a group switch happened
                  if (newVisibleId && prevVisibleId && newVisibleId !== prevVisibleId) {
                    const newVisible = transformed.panes.find(p => p.tmuxId === newVisibleId);
                    if (newVisible) {
                      groupSwitchOverride = {
                        paneId: newVisibleId,
                        fromPaneId: prevVisibleId,
                        x: newVisible.x,
                        y: newVisible.y,
                        width: newVisible.width,
                        height: newVisible.height,
                        timestamp: Date.now(),
                      };
                    }
                    break;
                  }
                }
              } else if (Date.now() - groupSwitchOverride.timestamp >= 750) {
                groupSwitchOverride = null;
              }

              enqueue(
                assign({
                  ...transformed,
                  paneGroups,
                  floatPanes,
                  lastUpdateTime: Date.now(),
                  // Clear optimistic tracking - server state overwrites any predictions
                  optimisticOperation: null,
                  groupSwitchDimOverride: groupSwitchOverride,
                })
              );
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_SESSION' as const,
                  sessionName: transformed.sessionName,
                })
              );

              // Schedule override clear and forced refresh after group switch detection
              if (groupSwitchOverride && !context.groupSwitchDimOverride) {
                const listPanesCmd = `list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}'`;
                enqueue(({ self }) => {
                  setTimeout(() => {
                    self.send({ type: 'CLEAR_GROUP_SWITCH_OVERRIDE' });
                  }, 750);
                  setTimeout(() => {
                    self.send({ type: 'SEND_COMMAND', command: listPanesCmd });
                  }, 550);
                });
              }

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

              // If tmux size doesn't match our target, notify server to update
              // client size (uses refresh-client -C for window-size smallest)
              const shouldResize =
                context.targetCols > 0 &&
                context.targetRows > 0 &&
                (context.targetCols !== transformed.totalWidth || context.targetRows !== transformed.totalHeight);
              if (shouldResize) {
                enqueue(
                  sendTo('tmux', {
                    type: 'INVOKE' as const,
                    cmd: 'set_client_size',
                    args: { cols: context.targetCols, rows: context.targetRows },
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
            // Expand tmux format strings that won't be resolved by control mode
            // (e.g., run-shell commands from expanded aliases in root keybindings)
            let command = event.command;
            if (context.activePaneId && (command.includes('#{pane_id}') || command.includes('#{pane_width}') || command.includes('#{pane_height}'))) {
              command = command.replace(/#{pane_id}/g, context.activePaneId);
              const activePane = context.panes.find(p => p.tmuxId === context.activePaneId);
              if (activePane) {
                command = command.replace(/#{pane_width}/g, String(activePane.width));
                command = command.replace(/#{pane_height}/g, String(activePane.height));
              }
            }

            // Don't apply optimistic updates for swap commands during drag
            // The drag machine already handles swaps optimistically
            const isDragging = context.drag !== null;

            // Try to parse and calculate optimistic prediction
            const parsed = parseCommand(command);
            const prediction = parsed
              ? calculatePrediction(
                  parsed,
                  context.panes,
                  context.activePaneId,
                  context.activeWindowId,
                  command
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
                command,
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

        // Clear group switch override (fired 750ms after group switch detection)
        CLEAR_GROUP_SWITCH_OVERRIDE: {
          actions: assign({ groupSwitchDimOverride: null }),
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
