import { setup, assign, sendTo, fromCallback, AnyActorRef, ActorRefFrom } from 'xstate';
import { createAdapter } from '../tmux/adapters';
import type { TmuxAdapter, ServerState } from '../tmux/types';
import type {
  AppMachineContext,
  AppMachineEvent,
  TmuxPane,
  TmuxWindow,
  KeyPressEvent,
  DragState,
  ResizeState,
} from './types';
import {
  formatTmuxKey,
  isPrefixKey,
  isCommandModeKey,
  getPaneNavCommand,
  getPrefixBinding,
} from './actors/keyboardActor';

const PREFIX_TIMEOUT = 2000;
const STATUS_BAR_HEIGHT = 33;

// ============================================
// Helper Functions
// ============================================

function camelize<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[camelKey] = camelize(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result as T;
}

function transformServerState(payload: ServerState): {
  sessionName: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
} {
  return {
    sessionName: payload.session_name,
    activeWindowId: payload.active_window_id,
    activePaneId: payload.active_pane_id,
    panes: payload.panes.map((p) => camelize<TmuxPane>(p as Record<string, unknown>)),
    windows: payload.windows.map((w) => camelize<TmuxWindow>(w as Record<string, unknown>)),
    totalWidth: payload.total_width,
    totalHeight: payload.total_height,
  };
}

/**
 * Build stacks from window names.
 * Stack windows have the pattern: __%{pane_id}_stack_{n}
 * After a swap, the "parent" pane may be in a hidden window, so we need to
 * determine which pane is actually visible (in the active window).
 */
function buildStacksFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  activeWindowId: string | null
): Record<string, { id: string; paneIds: string[]; activeIndex: number }> {
  const stacks: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {};

  // Find all stack windows and group by parent pane
  const stackWindowsByParent = new Map<string, TmuxWindow[]>();
  for (const window of windows) {
    if (window.isStackWindow && window.stackParentPane) {
      const parentId = window.stackParentPane;
      if (!stackWindowsByParent.has(parentId)) {
        stackWindowsByParent.set(parentId, []);
      }
      stackWindowsByParent.get(parentId)!.push(window);
    }
  }

  // Build stacks from grouped windows
  for (const [parentPaneId, stackWindows] of stackWindowsByParent) {
    // Sort by stack index
    stackWindows.sort((a, b) => (a.stackIndex ?? 0) - (b.stackIndex ?? 0));

    // Collect all panes in this stack (parent + hidden)
    // Start with parent pane
    const paneIds: string[] = [parentPaneId];

    // Add panes from stack windows
    for (const stackWindow of stackWindows) {
      const paneInWindow = panes.find((p) => p.windowId === stackWindow.id);
      if (paneInWindow) {
        paneIds.push(paneInWindow.tmuxId);
      }
    }

    // Only create a stack if there are multiple panes
    if (paneIds.length > 1) {
      // Determine which pane is currently visible (in the active window)
      // After a swap, any of the panes might be in the active window
      let activeIndex = 0;
      for (let i = 0; i < paneIds.length; i++) {
        const pane = panes.find((p) => p.tmuxId === paneIds[i]);
        if (pane && pane.windowId === activeWindowId) {
          activeIndex = i;
          break;
        }
      }

      stacks[parentPaneId] = {
        id: parentPaneId,
        paneIds,
        activeIndex,
      };
    }
  }

  return stacks;
}

/**
 * Compute preview panes for drag-to-swap operations
 * - During drag: target pane moves to dragged pane's position
 * - During commit: full swap of positions
 */
function computeDragPreview(
  panes: TmuxPane[],
  drag: DragState,
  isCommitting: boolean
): TmuxPane[] {
  const dragged = panes.find((p) => p.tmuxId === drag.draggedPaneId);
  if (!dragged || !drag.targetPaneId) return panes;

  const target = panes.find((p) => p.tmuxId === drag.targetPaneId);
  if (!target) return panes;

  if (isCommitting) {
    // Full swap during commit
    return panes.map((pane) => {
      if (pane.tmuxId === drag.draggedPaneId) {
        return { ...pane, x: target.x, y: target.y, width: target.width, height: target.height };
      }
      if (pane.tmuxId === drag.targetPaneId) {
        return { ...pane, x: dragged.x, y: dragged.y, width: dragged.width, height: dragged.height };
      }
      return pane;
    });
  }

  // During drag, only move target pane - dragged pane follows cursor via CSS transform
  return panes.map((pane) => {
    if (pane.tmuxId === drag.targetPaneId) {
      return { ...pane, x: dragged.x, y: dragged.y, width: dragged.width, height: dragged.height };
    }
    return pane;
  });
}

/**
 * Find swap target pane using mouse position
 */
function findSwapTarget(
  panes: TmuxPane[],
  draggedId: string,
  mouseX: number,
  mouseY: number,
  charWidth: number,
  charHeight: number
): string | null {
  const col = Math.floor(mouseX / charWidth);
  const row = Math.floor(mouseY / charHeight);

  for (const pane of panes) {
    if (pane.tmuxId === draggedId) continue;

    if (col >= pane.x && col < pane.x + pane.width && row >= pane.y && row < pane.y + pane.height) {
      return pane.tmuxId;
    }
  }

  return null;
}

// ============================================
// Actors
// ============================================

type TmuxActorEvent = { type: 'SEND_COMMAND'; command: string };

const tmuxActor = fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(({ input, receive }) => {
  const adapter: TmuxAdapter = createAdapter();

  const unsubscribeState = adapter.onStateChange((state) => {
    input.parent.send({ type: 'TMUX_STATE_UPDATE', state });
  });

  const unsubscribeError = adapter.onError((error) => {
    input.parent.send({ type: 'TMUX_ERROR', error });
  });

  adapter
    .connect()
    .then(async () => {
      input.parent.send({ type: 'TMUX_CONNECTED' });
      try {
        const state = await adapter.invoke<ServerState>('get_initial_state');
        input.parent.send({ type: 'TMUX_STATE_UPDATE', state });
      } catch (e) {
        console.error('Failed to get initial state:', e);
      }
    })
    .catch((error) => {
      input.parent.send({ type: 'TMUX_ERROR', error: error.message || 'Failed to connect' });
    });

  receive((event) => {
    if (event.type === 'SEND_COMMAND') {
      adapter.invoke<void>('run_tmux_command', { command: event.command }).catch((error) => {
        input.parent.send({ type: 'TMUX_ERROR', error: error.message || 'Command failed' });
      });
    }
  });

  return () => {
    unsubscribeState();
    unsubscribeError();
    adapter.disconnect();
  };
});

type KeyboardActorEvent = { type: '__unused__' };

const keyboardActor = fromCallback<KeyboardActorEvent, { parent: AnyActorRef }>(({ input }) => {
  const handleKeyDown = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    input.parent.send({
      type: 'KEY_PRESS',
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
});

// ============================================
// Machine Definition
// ============================================

export const appMachine = setup({
  types: {
    context: {} as AppMachineContext,
    events: {} as AppMachineEvent,
  },
  actors: {
    tmuxActor,
    keyboardActor,
  },
  guards: {
    hasDragTarget: ({ context }) => context.drag?.targetPaneId !== null,
    hasDragTargetNewWindow: ({ context }) => context.drag?.targetNewWindow === true,
    hasResizeDelta: ({ context }) =>
      context.resize !== null && (context.resize.pixelDelta.x !== 0 || context.resize.pixelDelta.y !== 0),
    isPrefixKey: ({ event }) => isPrefixKey(event as KeyPressEvent),
    isNavKey: ({ event }) => {
      const key = formatTmuxKey(event as KeyPressEvent);
      return getPaneNavCommand(key) !== null;
    },
    isCommandModeKey: ({ event }) => {
      const key = formatTmuxKey(event as KeyPressEvent);
      return isCommandModeKey(key);
    },
    isEscapeKey: ({ event }) => (event as KeyPressEvent).key === 'Escape',
  },
  delays: {
    PREFIX_TIMEOUT,
  },
}).createMachine({
  id: 'app',
  initial: 'connecting',
  context: {
    connected: false,
    error: null,
    sessionName: 'tmuxy',
    activeWindowId: null,
    activePaneId: null,
    panes: [],
    windows: [],
    totalWidth: 0,
    totalHeight: 0,
    previewPanes: [],
    stacks: {},
    targetCols: 80,
    targetRows: 24,
    drag: null,
    resize: null,
    commandInput: '',
    charWidth: 9.6,
    charHeight: 20,
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
  ],
  states: {
    connecting: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, error: null }),
        },
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
      },
    },

    idle: {
      initial: 'normal',
      on: {
        TMUX_STATE_UPDATE: {
          actions: assign(({ event }) => {
            const transformed = transformServerState(event.state);

            // Build stacks from window names - tmux is the source of truth
            const stacks = buildStacksFromWindows(transformed.windows, transformed.panes, transformed.activeWindowId);

            return {
              ...transformed,
              previewPanes: transformed.panes,
              stacks,
            };
          }),
        },
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
        TMUX_DISCONNECTED: {
          target: 'connecting',
          actions: assign({ connected: false }),
        },
        DRAG_START: {
          target: 'dragging',
          actions: assign(({ context, event }) => {
            const drag: DragState = {
              draggedPaneId: event.paneId,
              targetPaneId: null,
              targetNewWindow: false,
              startX: event.startX,
              startY: event.startY,
              currentX: event.startX,
              currentY: event.startY,
            };
            return {
              drag,
              previewPanes: context.panes, // No change yet
            };
          }),
        },
        RESIZE_START: {
          target: 'resizing',
          actions: assign(({ context, event }) => {
            const pane = context.panes.find((p) => p.tmuxId === event.paneId);
            if (!pane) return {};
            const resize: ResizeState = {
              paneId: event.paneId,
              handle: event.handle,
              startX: event.startX,
              startY: event.startY,
              originalPane: pane,
              pixelDelta: { x: 0, y: 0 },
              delta: { cols: 0, rows: 0 },
            };
            return {
              resize,
              // Don't update previewPanes - we'll apply pixel offset directly in PaneLayout
              previewPanes: context.panes,
            };
          }),
        },
        SET_CHAR_SIZE: {
          actions: assign(({ event }) => ({
            charWidth: event.charWidth,
            charHeight: event.charHeight,
          })),
        },
        SET_TARGET_SIZE: {
          actions: [
            assign(({ event }) => ({
              targetCols: event.cols,
              targetRows: event.rows,
            })),
            sendTo('tmux', ({ event }) => ({
              type: 'SEND_COMMAND' as const,
              command: `resize-window -x ${event.cols} -y ${event.rows}`,
            })),
          ],
        },
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
        // Stack operations - use hidden windows to manage stacks
        // Stack windows are named: __%{parent_pane_id}_stack_{n}
        STACK_ADD_PANE: {
          actions: sendTo('tmux', ({ context, event }) => {
            // Find next stack index for this pane
            const stack = context.stacks[event.paneId];
            const nextIndex = stack ? stack.paneIds.length : 1;
            // Extract just the number from pane ID (e.g., "%5" -> "5")
            const paneNum = event.paneId.replace('%', '');
            const windowName = `__%${paneNum}_stack_${nextIndex}`;
            // Create new hidden window with the stack naming pattern
            // Use -d to create detached (don't switch to it)
            return {
              type: 'SEND_COMMAND' as const,
              command: `new-window -d -n "${windowName}"`,
            };
          }),
        },
        STACK_SWITCH: {
          // Swap the visible pane with the hidden stacked pane
          actions: sendTo('tmux', ({ context, event }) => {
            const stack = context.stacks[event.stackId];
            if (!stack) return { type: 'SEND_COMMAND' as const, command: '' };

            const currentPaneId = stack.paneIds[0]; // Parent pane is always first (visible)
            const targetPaneId = event.paneId;

            // If trying to switch to already-visible pane, do nothing
            if (currentPaneId === targetPaneId) {
              return { type: 'SEND_COMMAND' as const, command: '' };
            }

            // Find the window containing the target pane
            const targetWindow = context.windows.find(
              (w) => w.isStackWindow && w.stackParentPane === event.stackId
            );
            if (!targetWindow) return { type: 'SEND_COMMAND' as const, command: '' };

            // Swap panes between the visible window and the hidden stack window
            // After swap, the previously hidden pane becomes visible
            return {
              type: 'SEND_COMMAND' as const,
              command: `swap-pane -s ${currentPaneId} -t ${targetPaneId}`,
            };
          }),
        },
        STACK_CLOSE_PANE: {
          // Kill the stack window containing this pane, then re-index remaining stack windows
          actions: sendTo('tmux', ({ context, event }) => {
            const stack = context.stacks[event.stackId];
            if (!stack) return { type: 'SEND_COMMAND' as const, command: '' };

            // Check if closing the visible pane (first in stack)
            const isClosingVisible = stack.paneIds[0] === event.paneId;

            if (isClosingVisible && stack.paneIds.length > 1) {
              // Swap with next pane first, then kill the (now hidden) original pane
              const nextPaneId = stack.paneIds[1];
              // Find the window containing the next pane
              const nextWindow = context.windows.find((w) => {
                if (!w.isStackWindow) return false;
                const paneInWindow = context.panes.find((p) => p.windowId === w.id);
                return paneInWindow?.tmuxId === nextPaneId;
              });
              if (nextWindow) {
                // Swap, then kill the window we swapped to
                return {
                  type: 'SEND_COMMAND' as const,
                  command: `swap-pane -s ${event.paneId} -t ${nextPaneId} \\; kill-window -t ${nextWindow.id}`,
                };
              }
            }

            // Closing a hidden pane - find and kill its window
            const targetWindow = context.windows.find((w) => {
              if (!w.isStackWindow) return false;
              const paneInWindow = context.panes.find((p) => p.windowId === w.id);
              return paneInWindow?.tmuxId === event.paneId;
            });

            if (targetWindow) {
              // Kill the stack window, re-indexing will happen on next state update
              // as the window names are parsed fresh each time
              return {
                type: 'SEND_COMMAND' as const,
                command: `kill-window -t ${targetWindow.id}`,
              };
            }

            // Fallback: kill the pane directly
            return {
              type: 'SEND_COMMAND' as const,
              command: `kill-pane -t ${event.paneId}`,
            };
          }),
        },
      },
      states: {
        normal: {
          on: {
            KEY_PRESS: [
              {
                guard: 'isPrefixKey',
                target: 'prefixWait',
              },
              {
                guard: 'isNavKey',
                actions: sendTo('tmux', ({ context, event }) => {
                  const key = formatTmuxKey(event as KeyPressEvent);
                  return { type: 'SEND_COMMAND' as const, command: `${getPaneNavCommand(key)!} -t ${context.sessionName}` };
                }),
              },
              {
                actions: sendTo('tmux', ({ context, event }) => {
                  const key = formatTmuxKey(event as KeyPressEvent);
                  return { type: 'SEND_COMMAND' as const, command: `send-keys -t ${context.sessionName} ${key}` };
                }),
              },
            ],
            COMMAND_MODE_ENTER: {
              target: 'commandMode',
              actions: assign({ commandInput: '' }),
            },
          },
        },
        prefixWait: {
          after: {
            PREFIX_TIMEOUT: { target: 'normal' },
          },
          on: {
            KEY_PRESS: [
              {
                guard: 'isCommandModeKey',
                target: 'commandMode',
                actions: assign({ commandInput: '' }),
              },
              {
                target: 'normal',
                actions: sendTo('tmux', ({ context, event }) => {
                  const key = formatTmuxKey(event as KeyPressEvent);
                  const binding = getPrefixBinding(key);
                  const session = context.sessionName;
                  // Add session targeting to the binding command
                  const targetedCommand = binding
                    ? `${binding} -t ${session}`
                    : `send-prefix -t ${session} \\; send-keys -t ${session} ${key}`;
                  return {
                    type: 'SEND_COMMAND' as const,
                    command: targetedCommand,
                  };
                }),
              },
            ],
          },
        },
        commandMode: {
          on: {
            KEY_PRESS: {
              guard: 'isEscapeKey',
              target: 'normal',
              actions: assign({ commandInput: '' }),
            },
            COMMAND_MODE_EXIT: {
              target: 'normal',
              actions: assign({ commandInput: '' }),
            },
            COMMAND_INPUT: {
              actions: assign(({ event }) => ({ commandInput: event.value })),
            },
            COMMAND_SUBMIT: {
              target: 'normal',
              actions: [
                sendTo('tmux', ({ context }) => ({
                  type: 'SEND_COMMAND' as const,
                  command: context.commandInput,
                })),
                assign({ commandInput: '' }),
              ],
            },
          },
        },
      },
    },

    dragging: {
      on: {
        TMUX_STATE_UPDATE: {}, // Ignore during drag
        KEY_PRESS: {
          guard: 'isEscapeKey',
          target: 'idle',
          actions: assign(({ context }) => ({
            drag: null,
            previewPanes: context.panes,
          })),
        },
        DRAG_MOVE: {
          actions: assign(({ context, event }) => {
            if (!context.drag) return {};

            const isOverStatusBar = event.clientY < STATUS_BAR_HEIGHT;

            let targetPaneId: string | null = null;

            if (!isOverStatusBar) {
              // Get mouse position relative to container
              const container = document.querySelector('.pane-layout');
              const containerRect = container?.getBoundingClientRect();
              const mouseX = containerRect ? event.clientX - containerRect.left : event.clientX;
              const mouseY = containerRect ? event.clientY - containerRect.top : event.clientY;

              // Find swap target pane
              targetPaneId = findSwapTarget(
                context.panes,
                context.drag.draggedPaneId,
                mouseX,
                mouseY,
                context.charWidth,
                context.charHeight
              );
            }

            const newDrag: DragState = {
              ...context.drag,
              targetPaneId,
              targetNewWindow: isOverStatusBar,
              currentX: event.clientX,
              currentY: event.clientY,
            };

            return {
              drag: newDrag,
              previewPanes: computeDragPreview(context.panes, newDrag, false),
            };
          }),
        },
        DRAG_END: [
          {
            guard: 'hasDragTargetNewWindow',
            target: 'committingDrag',
            actions: [
              assign(({ context }) => ({
                previewPanes: context.panes, // Reset preview, pane will be gone
              })),
              sendTo('tmux', ({ context }) => ({
                type: 'SEND_COMMAND' as const,
                command: `break-pane -s ${context.drag!.draggedPaneId}`,
              })),
            ],
          },
          {
            guard: 'hasDragTarget',
            target: 'committingDrag',
            actions: [
              assign(({ context }) => ({
                // Full swap preview during commit
                previewPanes: computeDragPreview(context.panes, context.drag!, true),
              })),
              sendTo('tmux', ({ context }) => {
                const cmd = `swap-pane -s ${context.drag!.draggedPaneId} -t ${context.drag!.targetPaneId}`;
                // Preserve the currently active pane after swap
                if (context.activePaneId) {
                  return {
                    type: 'SEND_COMMAND' as const,
                    command: `${cmd} \\; select-pane -t ${context.activePaneId}`,
                  };
                }
                return { type: 'SEND_COMMAND' as const, command: cmd };
              }),
            ],
          },
          {
            target: 'idle',
            actions: assign(({ context }) => ({
              drag: null,
              previewPanes: context.panes,
            })),
          },
        ],
        DRAG_CANCEL: {
          target: 'idle',
          actions: assign(({ context }) => ({
            drag: null,
            previewPanes: context.panes,
          })),
        },
      },
    },

    committingDrag: {
      after: {
        // Timeout fallback
        5000: {
          target: 'idle',
          actions: assign(({ context }) => ({
            drag: null,
            previewPanes: context.panes,
          })),
        },
      },
      on: {
        TMUX_STATE_UPDATE: {
          target: 'idle',
          actions: assign(({ event }) => {
            const transformed = transformServerState(event.state);
            return {
              ...transformed,
              previewPanes: transformed.panes,
              drag: null,
            };
          }),
        },
        TMUX_ERROR: {
          target: 'idle',
          actions: assign(({ context, event }) => ({
            error: event.error,
            drag: null,
            previewPanes: context.panes,
          })),
        },
      },
    },

    resizing: {
      on: {
        TMUX_STATE_UPDATE: {}, // Ignore during resize
        KEY_PRESS: {
          guard: 'isEscapeKey',
          target: 'idle',
          actions: assign(({ context }) => ({
            resize: null,
            previewPanes: context.panes,
          })),
        },
        RESIZE_MOVE: {
          actions: assign(({ context, event }) => {
            if (!context.resize) return {};

            const { paneId, handle } = context.resize;
            const { charWidth, charHeight } = context;

            // Track raw pixel delta
            const pixelDeltaX = event.clientX - context.resize.startX;
            const pixelDeltaY = event.clientY - context.resize.startY;

            // Calculate grid-snapped cols/rows delta
            const deltaCols = Math.round(pixelDeltaX / charWidth);
            const deltaRows = Math.round(pixelDeltaY / charHeight);

            const newResize: ResizeState = {
              ...context.resize,
              pixelDelta: { x: pixelDeltaX, y: pixelDeltaY },
              delta: { cols: deltaCols, rows: deltaRows },
            };

            // Update previewPanes with resized dimensions
            const resizedPane = context.panes.find((p) => p.tmuxId === paneId);
            if (!resizedPane) {
              return { resize: newResize };
            }

            // Find adjacent panes that need inverse resize
            const adjacentPaneIds = new Set<string>();
            // Find panes in the same row/column that resize together (same direction)
            const sameRowColPaneIds = new Set<string>();

            context.panes.forEach((p) => {
              if (p.tmuxId === paneId) return;
              switch (handle) {
                case 'e':
                  // Adjacent pane to the right
                  if (p.x === resizedPane.x + resizedPane.width + 1 &&
                      p.y < resizedPane.y + resizedPane.height &&
                      p.y + p.height > resizedPane.y) {
                    adjacentPaneIds.add(p.tmuxId);
                  }
                  // Panes in same column (same x and width) resize together
                  if (p.x === resizedPane.x && p.width === resizedPane.width) {
                    sameRowColPaneIds.add(p.tmuxId);
                  }
                  break;
                case 'w':
                  // Adjacent pane to the left
                  if (p.x + p.width + 1 === resizedPane.x &&
                      p.y < resizedPane.y + resizedPane.height &&
                      p.y + p.height > resizedPane.y) {
                    adjacentPaneIds.add(p.tmuxId);
                  }
                  // Panes in same column resize together
                  if (p.x === resizedPane.x && p.width === resizedPane.width) {
                    sameRowColPaneIds.add(p.tmuxId);
                  }
                  break;
                case 's':
                  // Adjacent pane below
                  if (p.y === resizedPane.y + resizedPane.height + 1 &&
                      p.x < resizedPane.x + resizedPane.width &&
                      p.x + p.width > resizedPane.x) {
                    adjacentPaneIds.add(p.tmuxId);
                  }
                  // Panes in same row (same y and height) resize together
                  if (p.y === resizedPane.y && p.height === resizedPane.height) {
                    sameRowColPaneIds.add(p.tmuxId);
                  }
                  break;
                case 'n':
                  // Adjacent pane above
                  if (p.y + p.height + 1 === resizedPane.y &&
                      p.x < resizedPane.x + resizedPane.width &&
                      p.x + p.width > resizedPane.x) {
                    adjacentPaneIds.add(p.tmuxId);
                  }
                  // Panes in same row resize together
                  if (p.y === resizedPane.y && p.height === resizedPane.height) {
                    sameRowColPaneIds.add(p.tmuxId);
                  }
                  break;
              }
            });

            // Calculate new dimensions for resized pane
            let newWidth = resizedPane.width;
            let newHeight = resizedPane.height;
            let newX = resizedPane.x;
            let newY = resizedPane.y;

            switch (handle) {
              case 'e':
                newWidth = Math.max(5, resizedPane.width + deltaCols);
                break;
              case 'w':
                newWidth = Math.max(5, resizedPane.width - deltaCols);
                newX = resizedPane.x + deltaCols;
                break;
              case 's':
                newHeight = Math.max(2, resizedPane.height + deltaRows);
                break;
              case 'n':
                newHeight = Math.max(2, resizedPane.height - deltaRows);
                newY = resizedPane.y + deltaRows;
                break;
            }

            // Update all panes with new dimensions
            const previewPanes = context.panes.map((p) => {
              if (p.tmuxId === paneId) {
                return { ...p, x: newX, y: newY, width: newWidth, height: newHeight };
              }
              if (sameRowColPaneIds.has(p.tmuxId)) {
                // Panes in same row/column resize in the same direction
                switch (handle) {
                  case 'e':
                  case 'w':
                    return { ...p, width: newWidth, x: handle === 'w' ? newX : p.x };
                  case 's':
                  case 'n':
                    return { ...p, height: newHeight, y: handle === 'n' ? newY : p.y };
                }
              }
              if (adjacentPaneIds.has(p.tmuxId)) {
                // Adjacent panes get inverse resize
                let adjWidth = p.width;
                let adjHeight = p.height;
                let adjX = p.x;
                let adjY = p.y;

                switch (handle) {
                  case 'e':
                    adjWidth = Math.max(5, p.width - deltaCols);
                    adjX = p.x + deltaCols;
                    break;
                  case 'w':
                    adjWidth = Math.max(5, p.width + deltaCols);
                    break;
                  case 's':
                    adjHeight = Math.max(2, p.height - deltaRows);
                    adjY = p.y + deltaRows;
                    break;
                  case 'n':
                    adjHeight = Math.max(2, p.height + deltaRows);
                    break;
                }
                return { ...p, x: adjX, y: adjY, width: adjWidth, height: adjHeight };
              }
              return p;
            });

            return {
              resize: newResize,
              previewPanes,
            };
          }),
        },
        RESIZE_END: [
          {
            guard: 'hasResizeDelta',
            target: 'committingResize',
            // Keep previewPanes as-is during commit (don't reset to panes)
            // This prevents snap-back when old tmux state arrives before our command is processed
            actions: [
              assign(({ context }) => ({
                // Preserve current preview state during commit
                previewPanes: context.previewPanes,
              })),
              sendTo('tmux', ({ context }) => {
              const { paneId, handle, pixelDelta } = context.resize!;
              const { charWidth, charHeight } = context;

              // Calculate grid-snapped cols/rows from pixel delta on mouse release
              const cols = Math.round(pixelDelta.x / charWidth);
              const rows = Math.round(pixelDelta.y / charHeight);

              let deltaCols = 0;
              let deltaRows = 0;

              switch (handle) {
                case 'e':
                  deltaCols = cols;
                  break;
                case 'w':
                  deltaCols = -cols;
                  break;
                case 's':
                  deltaRows = rows;
                  break;
                case 'n':
                  deltaRows = -rows;
                  break;
              }

              const commands: string[] = [];

              if (deltaCols !== 0) {
                const dir = deltaCols > 0 ? 'R' : 'L';
                commands.push(`resize-pane -t ${paneId} -${dir} ${Math.abs(deltaCols)}`);
              }
              if (deltaRows !== 0) {
                const dir = deltaRows > 0 ? 'D' : 'U';
                commands.push(`resize-pane -t ${paneId} -${dir} ${Math.abs(deltaRows)}`);
              }

              // If no actual resize needed (delta rounded to 0), use a no-op command
              const command = commands.length > 0 ? commands.join(' \\; ') : 'display-message ""';
              return { type: 'SEND_COMMAND' as const, command };
            }),
            ],
          },
          {
            target: 'idle',
            actions: assign(({ context }) => ({
              resize: null,
              previewPanes: context.panes,
            })),
          },
        ],
        RESIZE_CANCEL: {
          target: 'idle',
          actions: assign(({ context }) => ({
            resize: null,
            previewPanes: context.panes,
          })),
        },
      },
    },

    committingResize: {
      after: {
        // Timeout fallback
        5000: {
          target: 'idle',
          actions: assign(({ context }) => ({
            resize: null,
            previewPanes: context.panes,
          })),
        },
      },
      on: {
        TMUX_STATE_UPDATE: {
          target: 'idle',
          actions: assign(({ event }) => {
            const transformed = transformServerState(event.state);
            return {
              ...transformed,
              previewPanes: transformed.panes,
              resize: null,
            };
          }),
        },
        TMUX_ERROR: {
          target: 'idle',
          actions: assign(({ context, event }) => ({
            error: event.error,
            resize: null,
            previewPanes: context.panes,
          })),
        },
      },
    },
  },
});

export type AppMachine = typeof appMachine;
export type AppMachineActor = ActorRefFrom<typeof appMachine>;
