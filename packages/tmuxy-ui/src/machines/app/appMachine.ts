/**
 * App Machine - Parent orchestrator for the tmuxy application
 *
 * Coordinates:
 * - Actors (fromCallback, injected via factory):
 *   - tmuxActor: SSE/HTTP lifecycle, state updates
 *   - keyboardActor: keydown → formatTmuxKey → send-keys
 *   - sizeActor: window.resize, ResizeObserver, char measurement
 *
 * - Child Machines (stateful, no DOM access):
 *   - dragMachine: idle/dragging, spawns pointer listener
 *   - resizeMachine: idle/resizing, spawns pointer listener
 */

import {
  setup,
  assign,
  sendTo,
  enqueueActions,
  type ActorRefFrom,
  fromCallback,
  type AnyActorRef,
} from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../types';
import { createInitialContext } from './context';
import { uiPrefsState } from './states/uiPrefs';
import { uiPrefsActions } from './actions/uiPrefs';
import { commandUiState } from './states/commandUi';
import { commandUiActions } from './actions/commandUi';
import { copyModeState } from './states/copyMode';
import { copyModeActions, copyModeExitTimes, COPY_MODE_REENTRY_COOLDOWN } from './actions/copyMode';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from './states/groupsAndFloats';
import { groupsAndFloatsActions } from './actions/groupsAndFloats';
import { layoutState } from './states/layout';
import { layoutActions } from './actions/layout';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../constants';
import type { TmuxClientModel, TmuxSnapshot } from '../../tmux/store';
import type { TmuxStoreActorEvent } from '../actors/tmuxStoreActor';
import {
  buildGroupsFromWindows,
  buildFloatPanesFromWindows,
  parseCommandPrompt,
  parseDisplayMessage,
  STATUS_MESSAGE_DURATION,
} from './helpers';
import { applyFontSize } from '../../utils/fontSizeManager';
import type { CopyModeState, CellLine } from '../../tmux/types';

import { dragMachine } from '../drag/dragMachine';
import { resizeMachine } from '../resize/resizeMachine';
import type { KeyboardActorEvent } from '../actors/keyboardActor';
import type { TmuxActorEvent } from '../actors/tmuxActor';
import type { SizeActorEvent } from '../actors/sizeActor';
import type { ServersActorEvent } from '../actors/serversActor';

/**
 * Resolve relative window targets in tmux commands.
 *
 * With window-size manual, the control mode client's "current window"
 * (referenced by "." in target specs like ":.+") can drift from the user's
 * active window. This replaces the implicit "." with the explicit window ID
 * so commands target the correct window regardless of CC client state.
 */
function resolveWindowTarget(command: string, activeWindowId: string | null): string {
  if (activeWindowId && command.includes('-t :.')) {
    // Global: a compound command (e.g. `selectw -t :. ; swapw -t :.`) can carry
    // more than one relative window target — resolve every one, not just the first.
    return command.replace(/-t :\./g, `-t ${activeWindowId}.`);
  }
  return command;
}

/**
 * Materialize a mutable snapshot view from the TmuxClientModel.
 *
 * The derived arrays are passed through by REFERENCE — no cloning. The
 * store already preserves identity for unchanged panes/windows/arrays, so
 * spreading here would hand every subscriber a fresh identity on every
 * tick. This function only widens the store's readonly TmuxSnapshot types
 * to the mutable shapes the machine context declares.
 */
function snapshotFromModel(model: TmuxClientModel): {
  panes: TmuxSnapshot['panes'][number][];
  windows: TmuxSnapshot['windows'][number][];
  activePaneId: string | null;
  activeWindowId: string | null;
  totalWidth: number;
  totalHeight: number;
  statusLine: string;
  sessionName: string;
} {
  const d = model.derived;
  // Pass the derived arrays through by REFERENCE — the store already
  // preserves identity for unchanged panes/windows/arrays, and spreading
  // here would hand every subscriber a fresh identity on every tick.
  return {
    panes: d.panes as TmuxSnapshot['panes'][number][],
    windows: d.windows as TmuxSnapshot['windows'][number][],
    activePaneId: d.activePaneId,
    activeWindowId: d.activeWindowId,
    totalWidth: d.totalWidth,
    totalHeight: d.totalHeight,
    statusLine: d.statusLine,
    sessionName: d.sessionName,
  };
}

/** Move a pane ID to the front of the MRU list */
function updateActivationOrder(order: string[], paneId: string | null): string[] {
  if (!paneId) return order;
  return [paneId, ...order.filter((id) => id !== paneId)];
}

// parseCommandPrompt, parseDisplayMessage moved to ./helpers.ts

/**
 * Detect a tab-navigation command (`select-window -t N`, `next-window`,
 * `previous-window`) and resolve it to a concrete target window. Returns
 * `null` for any other command, or when the resolved target is the current
 * window (so SELECT_TAB can no-op without a wasted dispatch).
 *
 * The visual `select-window -t N` remap from Ctrl+1..9 must run *before*
 * calling this — by the time we look it up, the command should reference
 * a real tmux window index.
 */
function resolveTabNavTarget(
  command: string,
  context: AppMachineContext,
): { windowId: string; windowIndex: number } | null {
  if (!context.activeWindowId) return null;
  const visibleWindows = context.windows.filter((w) => w.windowType === 'tab');
  if (visibleWindows.length === 0) return null;

  const trimmed = command.trim();

  const selectMatch = trimmed.match(/^(select-window|selectw)\s+-t\s+:?=?(\d+)\s*$/);
  if (selectMatch) {
    const target = parseInt(selectMatch[2], 10);
    const targetWindow = visibleWindows.find((w) => w.index === target);
    if (targetWindow && targetWindow.id !== context.activeWindowId) {
      return { windowId: targetWindow.id, windowIndex: targetWindow.index };
    }
    return null;
  }

  const currentIdx = visibleWindows.findIndex((w) => w.id === context.activeWindowId);
  if (currentIdx === -1) return null;

  if (trimmed.match(/^(next-window|nextw|next)(\s|$)/)) {
    const target = visibleWindows[(currentIdx + 1) % visibleWindows.length];
    if (target && target.id !== context.activeWindowId) {
      return { windowId: target.id, windowIndex: target.index };
    }
    return null;
  }

  if (trimmed.match(/^(previous-window|prevw|prev)(\s|$)/)) {
    const target = visibleWindows[(currentIdx - 1 + visibleWindows.length) % visibleWindows.length];
    if (target && target.id !== context.activeWindowId) {
      return { windowId: target.id, windowIndex: target.index };
    }
    return null;
  }

  return null;
}

/**
 * Detect a pane-group-nav command and resolve it to the target pane id we'd
 * land on if the script ran. Returns `null` for any other command, or when
 * the resolved target is already the visible pane (so the optimistic flip
 * can no-op cleanly).
 *
 * Matches the command-alias form (`tmuxy-pane-group-prev/next`,
 * `tmuxy-nav-left/right`) and the expanded `run-shell` form for both. The
 * `nav` script does double duty — for panes inside a group, left/right step
 * through the group circularly; for other panes it falls back to tmux's
 * `select-pane -L/-R`. We only short-circuit when the active pane is in a
 * group, otherwise we let the binding flow to tmux unchanged.
 *
 * `pane-group-switch` is deliberately NOT matched — that's what
 * `SELECT_PANE_GROUP_TAB` itself emits and would recurse.
 */
function resolvePaneGroupNavTarget(
  command: string,
  context: AppMachineContext,
): { paneId: string } | null {
  const trimmed = command.trim();

  let direction: 'prev' | 'next' | null = null;
  if (trimmed.match(/^tmuxy-pane-group-prev\b/) || trimmed.includes('/pane-group-prev')) {
    direction = 'prev';
  } else if (trimmed.match(/^tmuxy-pane-group-next\b/) || trimmed.includes('/pane-group-next')) {
    direction = 'next';
  } else if (trimmed.match(/^tmuxy-nav-left\b/) || trimmed.match(/\/nav\s+left\b/)) {
    // Ctrl+H / Ctrl+Left — when the active pane is in a group, step left in
    // the group instead of letting the nav script run-shell out to swap-pane.
    direction = 'prev';
  } else if (trimmed.match(/^tmuxy-nav-right\b/) || trimmed.match(/\/nav\s+right\b/)) {
    direction = 'next';
  }
  if (!direction) return null;

  // Operate on the user's perceived focus — the optimistically-set activePaneId
  // — so back-to-back prev/next nav doesn't get stuck on a stale visible pane.
  const focusPaneId = context.activePaneId;
  if (!focusPaneId) return null;

  const group = Object.values(context.paneGroups).find((g) => g.paneIds.includes(focusPaneId));
  if (!group || group.paneIds.length <= 1) return null;

  // Mirror the shell scripts' algorithm: index off the currently-visible pane
  // (the one in the active window), step ±1 with wrap.
  const visibleId = group.paneIds.find((id) => {
    const p = context.panes.find((pp) => pp.tmuxId === id);
    return p?.windowId === context.activeWindowId;
  });
  if (!visibleId) return null;

  const idx = group.paneIds.indexOf(visibleId);
  const count = group.paneIds.length;
  const targetIdx = direction === 'next' ? (idx + 1) % count : (idx - 1 + count) % count;
  const target = group.paneIds[targetIdx];
  if (!target || target === visibleId) return null;

  return { paneId: target };
}

/**
 * Detect a horizontal pane-nav command (Ctrl+h / Ctrl+l → `tmuxy-nav-left/right`
 * or the expanded `run-shell .../nav left|right` form). Returns the direction or
 * null. Used for the sidebar boundary: Ctrl+h from the leftmost pane focuses the
 * open sidebar; Ctrl+l from a focused sidebar returns to the panes.
 */
function navDirection(command: string): 'left' | 'right' | null {
  const trimmed = command.trim();
  if (trimmed.match(/^tmuxy-nav-left\b/) || trimmed.match(/\/nav\s+left\b/)) return 'left';
  if (trimmed.match(/^tmuxy-nav-right\b/) || trimmed.match(/\/nav\s+right\b/)) return 'right';
  return null;
}

/**
 * Strip the `select-pane -t <id> \;` head that keyboardActor prepends to every
 * prefix/root binding (so tmux's server-side active pane aligns with the user's
 * focus before a `-t`-less binding runs). Returned form is what the client-side
 * intercepts and parsers expect; the original (with prefix) is what we forward
 * to tmux so the alignment actually happens for tmux-bound commands.
 */
function stripActivePanePrefix(command: string): string {
  const m = command.match(/^select-pane\s+-t\s+\S+\s+\\;\s+/);
  return m ? command.slice(m[0].length) : command;
}

export const appMachine = setup({
  types: {
    context: {} as AppMachineContext,
    events: {} as AllAppMachineEvents,
  },
  actors: {
    tmuxActor: fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(() => () => {}),
    tmuxStoreActor: fromCallback<TmuxStoreActorEvent, { parent: AnyActorRef }>(() => () => {}),
    keyboardActor: fromCallback<KeyboardActorEvent, { parent: AnyActorRef }>(() => () => {}),
    sizeActor: fromCallback<SizeActorEvent, { parent: AnyActorRef }>(() => () => {}),
    serversActor: fromCallback<ServersActorEvent, { parent: AnyActorRef }>(() => () => {}),
    dragMachine,
    resizeMachine,
  },
  actions: {
    ...uiPrefsActions,
    ...commandUiActions,
    ...copyModeActions,
    ...groupsAndFloatsActions,
    ...layoutActions,
  },
}).createMachine({
  id: 'app',
  initial: 'connecting',
  context: createInitialContext(),
  entry: [({ context }) => applyFontSize(context.baseFontSize)],
  invoke: [
    {
      id: 'tmux',
      src: 'tmuxActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      // The Tier-3 client model: bridges TmuxStore (Effect Ref) into XState.
      // SEND_TMUX_COMMAND relays here for optimistic dispatch; TMUX_STATE_UPDATE
      // relays here for reconcile. The actor forwards model changes back as
      // TMUX_MODEL_UPDATE so XState context stays in sync without any
      // optimistic-prediction code living in the machine itself.
      id: 'tmuxStore',
      src: 'tmuxStoreActor',
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
      // Sessions-tree poll (runs on web + desktop; see serversActor).
      id: 'servers',
      src: 'serversActor',
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
    // Per-state event handlers (parallel-state migration: Option D′).
    // Each `<name>State.on` slice owns events whose context-field writes
    // are restricted to that state per FIELD_OWNERS in ./context.ts.
    ...uiPrefsState.on,
    ...commandUiState.on,
    ...groupsAndFloatsGlobalEvents,

    LOG_APPEND: {
      actions: assign(({ context, event }) => {
        const entry = {
          timestamp: Date.now(),
          kind: event.kind,
          message: event.message,
        };
        // Cap log size so it never grows unbounded
        const next =
          context.log.length >= 500 ? [...context.log.slice(-499), entry] : [...context.log, entry];
        return { log: next };
      }),
    },
    // Sidebar sessions tree refreshed by the `serversActor` poll (web+desktop).
    // Root-level so it lands in any state (the poll runs continuously).
    SESSIONS_UPDATED: {
      actions: assign(({ event }) => ({ sessions: event.sessions })),
    },
    // Sidebar server picker refreshed by the same desktop-only poll.
    SERVERS_UPDATED: {
      actions: assign(({ event }) => ({
        serverList: event.serverList,
        currentServerId: event.currentServerId,
      })),
    },
    // OSC 52 clipboard write request from a terminal application. Mirror it
    // into the system clipboard via navigator.clipboard. Fire-and-forget —
    // a denied permission shouldn't break the rest of the machine. Updates
    // `lastClipboardWrite` so tests/UI can observe the most recent payload
    // without re-reading the system clipboard.
    TMUX_CLIPBOARD: {
      actions: ({ event }) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(event.text).catch((err) => {
            console.warn('[appMachine] OSC 52 clipboard write rejected:', err);
          });
        }
        const win = globalThis as unknown as {
          __tmuxyLastClipboard?: { paneId: string; text: string };
        };
        win.__tmuxyLastClipboard = { paneId: event.paneId, text: event.text };
      },
    },
    // Backend gave up reconnecting. The status screen reads `fatalError` to
    // show a non-recoverable banner instead of the "connecting…" spinner.
    // Target the `disconnected` terminal state so live-only event handlers
    // (connecting, idle, reconnecting) all stop firing.
    TMUX_FATAL: {
      target: '.disconnected',
      actions: assign(({ event }) => ({
        fatalError: event.message,
        connected: false,
      })),
    },
    // SSE/Tauri adapter detected the channel dropped and is retrying.
    // Global so the transition fires from any live state.
    // NOTE: `reconnecting` does NOT share idle's handlers — it declares its
    // own small `on` block (server state in, reconnect/disconnect out). Input
    // events (SEND_TMUX_COMMAND, KEY_PRESS, FOCUS_PANE, drag/resize) are
    // therefore dropped while the banner is up, which matches the transport
    // being down: there is nothing to send them over. The keyboard actor
    // stays enabled, so keystrokes are swallowed rather than reaching the
    // browser. If we ever want them buffered and flushed on reconnect, that
    // needs an explicit queue, not a handler spread.
    TMUX_RECONNECTING: {
      target: '.reconnecting',
      actions: assign(({ event }) => ({
        connected: false,
        reconnectAttempt: event.attempt,
      })),
    },
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
          }),
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
            }),
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
            }),
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
    // SET_ANIMATION_ROOT — handled by uiPrefsState (see spread at end of on:)

    // Focus gating events
    APP_FOCUS: {
      actions: [
        assign({ appFocused: true }),
        sendTo('keyboard', { type: 'UPDATE_ENABLED' as const, enabled: true }),
      ],
    },
    APP_BLUR: {
      actions: [
        assign({ appFocused: false }),
        sendTo('keyboard', { type: 'UPDATE_ENABLED' as const, enabled: false }),
      ],
    },

    // PREFIX_MODE_CHANGE — handled by commandUiState

    // Connection info events
    CONNECTION_INFO: {
      actions: assign(({ event }) => ({
        defaultShell: event.defaultShell,
      })),
    },

    // Command mode + status message events — handled by commandUiState

    // Single entry point for tab creation — re-raised as SEND_TMUX_COMMAND
    // so the "+" button and tab menu items pick up the same optimistic
    // prediction + reconciliation path that the prefix+c keybinding gets.
    CREATE_TAB: {
      actions: enqueueActions(({ enqueue }) => {
        enqueue.raise({ type: 'SEND_TMUX_COMMAND', command: 'new-window' });
      }),
    },

    // Theme events (global — work in any state)
    // Theme + font-size events — handled by uiPrefsState (see spread at end of on:)

    // Session events (global — work in any state)
    SWITCH_SESSION: {
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue(
          assign({
            panes: [],
            windows: [],
            floatPanes: {},
            focusedFloatPaneId: null,
            paneGroups: {},
            activeWindowId: null,
            activePaneId: null,
            sessionName: event.sessionName,
            connected: false,
            error: null,
            copyModeStates: {},
            enableAnimations: false,
          }),
        );
        // Drop any pending ops + committed state — they belong to the
        // previous session's pane/window ids. Without this the store would
        // try to reconcile the new session's first snapshot against the old
        // one and stale-timeout the orphaned ops 2 seconds later.
        enqueue(sendTo('tmuxStore', { type: 'CLEAR' as const }));
        enqueue(
          sendTo('tmux', {
            type: 'SWITCH_SESSION' as const,
            sessionName: event.sessionName,
          }),
        );
        // Update browser URL without reload
        enqueue(() => {
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.set('session', event.sessionName);
            window.history.pushState({}, '', url.toString());
          }
        });
      }),
    },
    // OPEN_SESSION_FLOAT, OPEN_CONNECT_FLOAT — handled by groupsAndFloatsGlobalEvents
    SESSION_SWITCH_REQUESTED: {
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue(({ self }) => {
          self.send({ type: 'SWITCH_SESSION', sessionName: event.sessionName });
        });
      }),
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

            // Fetch theme settings and available themes
            enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
            enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));

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
                }),
              );
            }
            // Otherwise, sizeActor will send SET_TARGET_SIZE which triggers FETCH_INITIAL_STATE
          }),
        },
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
        // Keybindings may arrive before TMUX_CONNECTED (e.g. DemoAdapter emits synchronously)
        KEYBINDINGS_RECEIVED: {
          actions: [
            assign({ keybindings: ({ event }) => event.keybindings }),
            sendTo('keyboard', ({ event }) => ({
              type: 'UPDATE_KEYBINDINGS' as const,
              keybindings: event.keybindings,
            })),
          ],
        },
      },
    },

    idle: {
      on: {
        // Per-state handlers active only during idle (require a live connection).
        ...copyModeState.on,
        ...groupsAndFloatsIdleEvents,
        ...layoutState.on,

        // Tmux Events
        // TMUX_STATE_UPDATE (the wire event) is now a one-liner: hand the
        // server snapshot to the TmuxStore. The store reconciles pending
        // optimistic ops, recomputes `derived`, and notifies the subscriber
        // (tmuxStoreActor) which forwards a TMUX_MODEL_UPDATE event. All the
        // heavy lifting (group/float build, copy-mode detection, animations)
        // lives in that handler below.
        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_MODEL_UPDATE: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            const transformed = snapshotFromModel(event.model);

            // Skip spurious empty-pane states from the server
            if (transformed.panes.length === 0) return;

            // Anti-flash: a freshly-created window can be reported active
            // BEFORE its pane's window mapping settles — break-pane emits
            // %window-add (and the session's active-window flip) a beat
            // before the moved pane's window_id updates. Rendering it now
            // flashes an empty tab (the active window has zero visible
            // panes). Defer until the pane arrives; the very next emit
            // carries it. Guarded to the switch transient (active window
            // changed, we were rendering panes, the new one has none) so a
            // legitimately-empty state still applies once the window settles.
            // tmux never leaves a window pane-less for long, so this can't
            // wedge — the periodic sync re-emits with the pane.
            const switchingWindow = transformed.activeWindowId !== context.activeWindowId;
            const newActiveHasPanes = transformed.panes.some(
              (p) => p.windowId === transformed.activeWindowId,
            );
            const currentlyRenderingPanes = context.panes.some(
              (p) => p.windowId === context.activeWindowId,
            );
            // Only when no optimistic op is in flight: an optimistic
            // NewWindow legitimately makes a (placeholder) window active with
            // its placeholder pane, and its rollback must apply normally —
            // the break-pane transient this guards is a server-driven
            // RawCommand path with no pending op.
            const opsInFlight = event.model.ops.length > 0;
            if (!opsInFlight && switchingWindow && !newActiveHasPanes && currentlyRenderingPanes)
              return;

            // Optimistic reconciliation moved out of XState — TmuxStore owns
            // it now. By the time TMUX_MODEL_UPDATE fires, `event.model.derived`
            // already includes any in-flight predicted patches, and
            // `event.model.paneKeyOverrides` already maps freshly-confirmed
            // real pane IDs back to their placeholder React keys. No
            // placeholder reinjection, no stale-timeout dance, no
            // position-tolerance heuristics in this handler.

            // Skip heavy structural computations when only content changed.
            // Compare pane count, window count, active window, and window names.
            // Content-only deltas only change pane content/cursor, not structure.
            const structurallyChanged =
              transformed.panes.length !== context.panes.length ||
              transformed.activeWindowId !== context.activeWindowId ||
              transformed.windows.length !== context.windows.length ||
              transformed.windows.some((w, i) => {
                const prev = context.windows[i];
                if (!prev) return true;
                if (w.name !== prev.name) return true;
                // Window-type and group membership flips need to rebuild
                // paneGroups too — without this, a window that arrives
                // initially untagged and later flips to windowType=group
                // (auto-adopt or set-option round-trip) never produces
                // a tab strip.
                if (w.windowType !== prev.windowType) return true;
                // Float option metadata (@tmuxy-float-*) can arrive on a
                // LATER list-windows sync than the window-type tag; without
                // comparing it, a drawer float renders as a centered modal
                // forever because floatPanes is never rebuilt.
                if (
                  w.floatDrawer !== prev.floatDrawer ||
                  w.floatWidth !== prev.floatWidth ||
                  w.floatHeight !== prev.floatHeight ||
                  w.floatBg !== prev.floatBg ||
                  w.floatNoheader !== prev.floatNoheader ||
                  Boolean(w.zoomed) !== Boolean(prev.zoomed)
                ) {
                  return true;
                }
                const a = w.groupPanes ?? [];
                const b = prev.groupPanes ?? [];
                if (a.length !== b.length) return true;
                for (let j = 0; j < a.length; j++) {
                  if (a[j] !== b[j]) return true;
                }
                return false;
              }) ||
              transformed.panes.some(
                (p) => p.windowId !== context.panes.find((cp) => cp.tmuxId === p.tmuxId)?.windowId,
              );

            let paneGroups = structurallyChanged
              ? buildGroupsFromWindows(
                  transformed.windows,
                  transformed.panes,
                  transformed.activeWindowId,
                )
              : context.paneGroups;

            // Prune stale groups: if a group references pane IDs that no longer
            // exist in the updated pane list, remove those IDs. Drop groups that
            // become empty or have only one pane (no longer a group).
            if (!structurallyChanged && Object.keys(paneGroups).length > 0) {
              const paneIdSet = new Set(transformed.panes.map((p) => p.tmuxId));
              const pruned: typeof paneGroups = {};
              let changed = false;
              for (const [key, group] of Object.entries(paneGroups)) {
                const validIds = group.paneIds.filter((id) => paneIdSet.has(id));
                if (validIds.length >= 2) {
                  pruned[key] =
                    validIds.length === group.paneIds.length
                      ? group
                      : { ...group, paneIds: validIds };
                  if (validIds.length !== group.paneIds.length) changed = true;
                } else {
                  changed = true;
                }
              }
              if (changed) {
                paneGroups = pruned;
              }
            }

            let floatPanes = structurallyChanged
              ? buildFloatPanesFromWindows(
                  transformed.windows,
                  transformed.panes,
                  context.floatPanes,
                  context.containerWidth,
                  context.containerHeight,
                  context.charWidth,
                  context.charHeight,
                )
              : context.floatPanes;

            // Prune dead floats: if a float's pane no longer exists in the
            // updated pane list, remove it. Handles external kills where the
            // float window disappears via %unlinked-window-close.
            const currentPaneIdSet = new Set(transformed.panes.map((p) => p.tmuxId));
            const deadFloatIds = Object.keys(floatPanes).filter((id) => !currentPaneIdSet.has(id));
            if (deadFloatIds.length > 0) {
              floatPanes = { ...floatPanes };
              for (const id of deadFloatIds) {
                delete floatPanes[id];
              }
            }

            // Detect float removal — check for session switch env var
            const prevFloatCount = Object.keys(context.floatPanes).length;
            const newFloatCount = Object.keys(floatPanes).length;
            if (prevFloatCount > 0 && newFloatCount < prevFloatCount) {
              enqueue(sendTo('tmux', { type: 'CHECK_SESSION_SWITCH' as const }));
            }

            // Auto-focus float management:
            // - When a new float appears, auto-focus it (topmost = last in list)
            // - When floats disappear, update focused float or clear it
            const newFloatIds = Object.keys(floatPanes);
            const prevFloatIds = Object.keys(context.floatPanes);
            const addedFloatIds = newFloatIds.filter((id) => !prevFloatIds.includes(id));
            let newFocusedFloat = context.focusedFloatPaneId;
            if (addedFloatIds.length > 0) {
              // New float(s) appeared — focus the topmost one
              newFocusedFloat = newFloatIds[newFloatIds.length - 1];
              // Suppress layout animation: the split-window → break-pane
              // workaround creates a momentary extra pane in the active window
              // before it becomes a float. Disabling animation prevents the blink.
              enqueue(assign({ enableAnimations: false }));
            } else if (newFocusedFloat && !floatPanes[newFocusedFloat]) {
              // The focused float was removed — focus the new topmost, or clear
              newFocusedFloat = newFloatIds.length > 0 ? newFloatIds[newFloatIds.length - 1] : null;
            }
            if (newFocusedFloat !== context.focusedFloatPaneId) {
              enqueue(assign({ focusedFloatPaneId: newFocusedFloat }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_FOCUSED_FLOAT' as const,
                  paneId: newFocusedFloat,
                }),
              );
            }

            // Detect tmux entering copy mode (e.g. prefix+[) — init client-side copy mode
            let updatedCopyModeStates = context.copyModeStates;
            for (const newPane of transformed.panes) {
              const prevPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
              if (
                newPane.inMode &&
                (!prevPane || !prevPane.inMode) &&
                !context.copyModeStates[newPane.tmuxId]
              ) {
                // Skip if we recently exited copy mode for this pane (stale inMode flag)
                const exitTime = copyModeExitTimes.get(newPane.tmuxId);
                if (exitTime && Date.now() - exitTime < COPY_MODE_REENTRY_COOLDOWN) {
                  continue;
                }
                // Pane just entered copy mode — initialize with pre-populated content
                const hs = newPane.historySize ?? 0;
                const tl = hs + newPane.height;
                const preLines = new Map<number, CellLine>();
                for (let i = 0; i < newPane.content.length; i++) {
                  preLines.set(hs + i, newPane.content[i]);
                }
                const preRanges: Array<[number, number]> =
                  newPane.content.length > 0 ? [[hs, hs + newPane.content.length - 1]] : [];
                const copyState: CopyModeState = {
                  lines: preLines,
                  totalLines: tl,
                  historySize: hs,
                  loadedRanges: preRanges,
                  loading: true,
                  width: newPane.width,
                  height: newPane.height,
                  cursorRow: hs + newPane.cursorY,
                  cursorCol: newPane.cursorX,
                  selectionMode: null,
                  selectionAnchor: null,
                  scrollTop: Math.max(0, tl - newPane.height),
                };
                updatedCopyModeStates = { ...updatedCopyModeStates, [newPane.tmuxId]: copyState };
                // Match the user-initiated ENTER_COPY_MODE fetch range —
                // request the entire live history (capped by tmux's actual
                // backlog), not a fixed `height + 200` slab. The narrower
                // request silently truncated scrollback for any pane that
                // entered copy mode without going through the frontend's
                // intercept (CLI `tmuxy run copy-mode`, custom `run-shell`
                // bindings, anything that flipped `in_mode` server-side),
                // making scrollback above ~200 lines invisible on scroll.
                enqueue(
                  sendTo('tmux', {
                    type: 'FETCH_SCROLLBACK_CELLS' as const,
                    paneId: newPane.tmuxId,
                    start: -hs,
                    end: newPane.height - 1,
                  }),
                );
              }
              // Detect tmux exiting copy mode — clean up client-side copy mode
              if (!newPane.inMode && prevPane?.inMode && context.copyModeStates[newPane.tmuxId]) {
                updatedCopyModeStates = { ...updatedCopyModeStates };
                delete updatedCopyModeStates[newPane.tmuxId];
              }
            }

            // Prune copy mode state for panes that no longer exist — e.g. the
            // user closed a pane while it was in copy mode. Keyboard copy-mode
            // routing is derived from copyModeStates[activePaneId], so leaving a
            // stale entry could keep keys routed to a dead pane's copy mode
            // during the brief window before activePaneId moves to a live pane.
            for (const staleId of Object.keys(updatedCopyModeStates)) {
              if (!currentPaneIdSet.has(staleId)) {
                updatedCopyModeStates = { ...updatedCopyModeStates };
                delete updatedCopyModeStates[staleId];
              }
            }

            // Detect pane dimension changes from command-based resize
            // (not drag-resize, which uses resizeActive). Suppress CSS
            // transitions so dimensions snap instantly without visual jumps.
            const hasDimensionChange =
              !context.resizeActive &&
              transformed.panes.some((newPane) => {
                const oldPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
                return (
                  oldPane &&
                  (oldPane.x !== newPane.x ||
                    oldPane.y !== newPane.y ||
                    oldPane.width !== newPane.width ||
                    oldPane.height !== newPane.height)
                );
              });

            // Preserve activePaneId during transient states (e.g., pane-group-add
            // sends null activePaneId between break-pane and swap-pane).
            // Also preserve during layout transitions — tmux briefly reports a
            // different active pane during layout recomputation, causing class churn.
            // Detect layout transitions both from explicit commands (lastLayoutCommandTime)
            // and from state changes (same pane set with different dimensions).
            const samePaneSet =
              hasDimensionChange &&
              transformed.panes.length === context.panes.length &&
              transformed.panes.every((p) => context.panes.some((cp) => cp.tmuxId === p.tmuxId));
            const isLayoutTransition =
              context.activePaneId !== null &&
              transformed.activePaneId !== null &&
              transformed.panes.some((p) => p.tmuxId === context.activePaneId) &&
              ((context.lastLayoutCommandTime > 0 &&
                Date.now() - context.lastLayoutCommandTime < 500) ||
                samePaneSet);
            const effectiveActivePaneId = isLayoutTransition
              ? context.activePaneId
              : (transformed.activePaneId ?? context.activePaneId);

            // Record each window's active pane as confirmed by the server,
            // so SELECT_TAB can restore focus to the right pane on return.
            const lastActivePaneByWindow = { ...context.lastActivePaneByWindow };
            for (const pane of transformed.panes) {
              if (pane.active && pane.windowId) {
                lastActivePaneByWindow[pane.windowId] = pane.tmuxId;
              }
            }

            enqueue(
              assign(({ context: ctx, event: ev }) => ({
                ...transformed,
                activePaneId: effectiveActivePaneId,
                paneGroups,
                floatPanes,
                copyModeStates: updatedCopyModeStates,
                // Clear held resize preview only after resize drag ends.
                // During active resize, keep the preview to avoid size jumps
                // from intermediate %layout-change events.
                resize: ctx.resizeActive ? ctx.resize : null,
                // Derived, no debounce timer: the flag rides the same React
                // commit as the new geometry. It relaxes only after TWO
                // consecutive quiet updates because a dirty optimistic
                // update and its instant quiet confirm can batch into one
                // commit — releasing on the quiet update alone would let
                // the batch's net geometry delta animate.
                suppressLayoutTransition: hasDimensionChange || !ctx.lastUpdateQuiet,
                lastUpdateQuiet: !hasDimensionChange,
                // Panes involved in in-flight GroupSwitch ops — mirrored
                // from the store's op log so selectGroupSwitchPaneIds can
                // suppress CSS transitions on the swapped panes without
                // any machine-side timers.
                groupSwitchPaneIds: ev.model.ops.flatMap((pendingOp) =>
                  pendingOp.op._tag === 'GroupSwitch'
                    ? [pendingOp.op.clickedPaneId, pendingOp.op.visiblePaneId]
                    : [],
                ),
                // Stable React key overrides for morphed placeholders —
                // owned by TmuxStore now, mirrored into context for selectors.
                paneKeyOverrides: ev.model.paneKeyOverrides,
                // Track pane activation order (MRU) for navigation prediction
                paneActivationOrder:
                  effectiveActivePaneId !== ctx.activePaneId
                    ? updateActivationOrder(ctx.paneActivationOrder, effectiveActivePaneId)
                    : ctx.paneActivationOrder,
                lastActivePaneByWindow,
              })),
            );
            // Mirror the MRU order into the store's predict context — the
            // Navigate predictor's tmux-accurate tiebreak reads it there.
            enqueue(
              sendTo('tmuxStore', ({ context: ctx }) => ({
                type: 'UPDATE_PREDICT_CONTEXT' as const,
                defaultShell: ctx.defaultShell,
                paneActivationOrder: ctx.paneActivationOrder,
              })),
            );
            enqueue(
              sendTo('keyboard', {
                type: 'UPDATE_SESSION' as const,
                sessionName: transformed.sessionName,
              }),
            );
            enqueue(
              sendTo('keyboard', {
                type: 'UPDATE_ACTIVE_PANE' as const,
                paneId: effectiveActivePaneId,
              }),
            );

            // NOTE: Do NOT sync panes to drag machine during drag.
            // The drag machine maintains its own optimistic pane positions after
            // each swap. Server state updates arrive asynchronously and would
            // overwrite the optimistic positions, causing target detection to break.

            // If tmux size doesn't match our target, notify server to update
            // client size (uses refresh-client -C for window-size smallest)
            const shouldResize =
              context.targetCols > 0 &&
              context.targetRows > 0 &&
              (context.targetCols !== transformed.totalWidth ||
                context.targetRows !== transformed.totalHeight);
            if (shouldResize) {
              enqueue(
                sendTo('tmux', {
                  type: 'INVOKE' as const,
                  cmd: 'set_client_size',
                  args: { cols: context.targetCols, rows: context.targetRows },
                }),
              );
            }

            // Re-enable animations after TWO consecutive QUIET updates
            // (no geometry delta on existing panes) with no pending client
            // resize round-trip. One quiet update isn't enough: an
            // optimistic dirty update and its instant quiet confirm can
            // batch into a single React commit, and enabling there would
            // animate the batch's net geometry delta (see lastUpdateQuiet).
            // Pane additions don't block it — freshly mounted nodes can't
            // run a CSS transition. This replaces the old 200/1000ms settle
            // timer with the invariant it approximated: the suppressed
            // geometry has provably reached a commit before transitions
            // come back.
            if (
              !context.enableAnimations &&
              context.targetCols > 0 &&
              !shouldResize &&
              !hasDimensionChange &&
              context.lastUpdateQuiet
            ) {
              enqueue(assign({ enableAnimations: true }));
            }
          }),
        },
        TMUX_ERROR: {
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue(assign({ error: event.error }));
            enqueue(({ self }) => {
              self.send({ type: 'SHOW_STATUS_MESSAGE', text: event.error });
            });
          }),
        },
        TMUX_DISCONNECTED: {
          target: 'disconnected',
          actions: assign({ connected: false, enableAnimations: false }),
        },

        // Keyboard actor events
        SEND_TMUX_COMMAND: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            // Expand tmux format strings that won't be resolved by control mode
            // (e.g., run-shell commands from expanded aliases in root keybindings)
            let command = event.command;
            if (
              context.activePaneId &&
              (command.includes('#{pane_id}') ||
                command.includes('#{pane_width}') ||
                command.includes('#{pane_height}'))
            ) {
              command = command.replace(/#{pane_id}/g, context.activePaneId);
              const activePane = context.panes.find((p) => p.tmuxId === context.activePaneId);
              if (activePane) {
                command = command.replace(/#{pane_width}/g, String(activePane.width));
                command = command.replace(/#{pane_height}/g, String(activePane.height));
              }
            }

            // Resolve relative window targets (see resolveWindowTarget docs)
            command = resolveWindowTarget(command, context.activeWindowId);

            // Match intercepts against the binding tail (keyboardActor prepends
            // `select-pane -t <id> \;` to every prefix/root binding). Keep
            // forwarding the original `command` so tmux still sees the
            // alignment prefix for commands that aren't intercepted.
            let tail = stripActivePanePrefix(command);

            // Intercept copy-mode — activate client-side copy mode
            if (tail.match(/^copy-mode\b/)) {
              const paneId = context.activePaneId;
              if (paneId) {
                enqueue.raise({ type: 'ENTER_COPY_MODE', paneId });
              }
              return;
            }

            // Intercept command-prompt — enter client-side command mode
            if (tail.match(/^command-prompt\b/)) {
              const parsed = parseCommandPrompt(tail, context);
              enqueue(
                assign({
                  commandMode: {
                    prompt: parsed.prompt,
                    input: parsed.initialValue,
                    template: parsed.template,
                  },
                }),
              );
              return;
            }

            // Intercept display-message (without -p) — show in status bar
            if (tail.match(/^display-message\b/)) {
              const msg = parseDisplayMessage(tail);
              if (msg !== null) {
                enqueue(assign({ statusMessage: { text: msg, timestamp: Date.now() } }));
                enqueue(({ self }) => {
                  setTimeout(() => {
                    self.send({ type: 'CLEAR_STATUS_MESSAGE' });
                  }, STATUS_MESSAGE_DURATION);
                });
                return;
              }
            }

            // Intercept select-window -t <N> from Ctrl+number keybindings.
            // Remap the visual tab index to the actual tmux window index,
            // since pane group windows consume intermediate indices.
            const selectWindowMatch = tail.match(/^select-window\s+-t\s+(\d+)$/);
            if (selectWindowMatch) {
              const targetIndex = parseInt(selectWindowMatch[1], 10);
              const visibleWindows = context.windows.filter((w) => w.windowType === 'tab');
              const targetWindow = visibleWindows.find((_, i) => i + 1 === targetIndex);
              if (targetWindow) {
                tail = `select-window -t ${targetWindow.index}`;
                command = tail;
              }
            }

            // Route tab-nav commands (select-window / next-window / previous-window)
            // through SELECT_TAB so they share the optimistic flip and
            // lastActivePaneByWindow bookkeeping with UI clicks.
            const tabNavTarget = resolveTabNavTarget(tail, context);
            if (tabNavTarget) {
              enqueue.raise({
                type: 'SELECT_TAB',
                windowId: tabNavTarget.windowId,
                windowIndex: tabNavTarget.windowIndex,
              });
              return;
            }

            // Sidebar boundary (while focused): Ctrl+l returns focus to the
            // panes; Ctrl+h is a no-op (nothing further left). Checked before
            // group nav so leaving the sidebar always works, even when the
            // underlying active pane happens to be in a group.
            const navDir = navDirection(tail);
            if (context.sidebarFocused && navDir) {
              if (navDir === 'right') enqueue.raise({ type: 'BLUR_SIDEBAR' });
              return;
            }

            // Same routing for pane-group nav (prev/next): share the
            // optimistic swap + keyboard re-target path with TAB clicks so
            // `<prefix> -` and friends don't lag the visible state.
            const groupNavTarget = resolvePaneGroupNavTarget(tail, context);
            if (groupNavTarget) {
              enqueue.raise({
                type: 'SELECT_PANE_GROUP_TAB',
                paneId: groupNavTarget.paneId,
              });
              return;
            }

            // Sidebar boundary (entering): Ctrl+h from the leftmost pane focuses
            // the open sidebar instead of doing a tmux `select-pane -L` no-op.
            // After group nav so group cycling still wins for grouped panes.
            if (navDir === 'left' && context.sidebarOpen) {
              const activePane = context.panes.find((p) => p.tmuxId === context.activePaneId);
              if (activePane && activePane.x === 0) {
                enqueue.raise({ type: 'FOCUS_SIDEBAR' });
                return;
              }
            }

            // Suppress layout animations for the duration of a NewWindow
            // dispatch. The post-confirm TMUX_MODEL_UPDATE re-enables
            // animations naturally (the same `enableAnimations` settle path
            // runs as before). Same logic for multi-step pane-group/float
            // shell scripts: the server settles their intermediate window
            // events into a single delta, but the resulting active-pane swap
            // can still trigger a CSS transition we don't want. Splits are
            // NOT suppressed: PaneLayout's enter/shift lifecycle owns the
            // split morph, and paneKeyOverrides keeps the placeholder→real
            // swap on one stable key/DOM node, so nothing flashes on confirm.
            const isNew = /^(new-window|neww)\b/.test(tail);
            const isMultiStepRunShell =
              /^run-shell\b/.test(tail) &&
              /pane-group-(add|close|switch|next|prev)|float-create/.test(tail);
            if (isNew || isMultiStepRunShell) {
              enqueue(assign({ enableAnimations: false }));
            }

            // Track layout commands to suppress transient active pane changes
            if (/^(next-layout|previous-layout|select-layout|selectl)\b/.test(tail)) {
              enqueue(assign({ lastLayoutCommandTime: Date.now() }));
            }

            // Dispatch through the TmuxStore — it parses the command into a
            // typed op, applies the optimistic patch synchronously (TmuxStore
            // subscribers see the new derived model immediately, including
            // this XState machine which assigns context.panes/etc. on
            // TMUX_MODEL_UPDATE), and forwards the command to the adapter.
            // On a tmux rejection the patch is rolled back automatically.
            // Drag-time swaps get the store's Swap prediction like any other
            // path: the drag machine's own pane shuffle is PRIVATE hit-testing
            // state (never rendered), so without the predicted patch the
            // dropped pane snapped back to its original slot until the server
            // %layout-change landed, then slid again — two motions for one drop.
            enqueue(
              sendTo('tmuxStore', {
                type: 'DISPATCH_COMMAND' as const,
                command,
              }),
            );
          }),
        },
        KEYBINDINGS_RECEIVED: {
          actions: [
            assign({ keybindings: ({ event }) => event.keybindings }),
            sendTo('keyboard', ({ event }) => ({
              type: 'UPDATE_KEYBINDINGS' as const,
              keybindings: event.keybindings,
            })),
          ],
        },
        // Drag Events - Forward to drag machine with full context
        DRAG_START: {
          actions: [
            assign(({ event, context }) => {
              const pane = context.panes.find((p) => p.tmuxId === event.paneId);
              return {
                drag: {
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
                },
              };
            }),
            sendTo('dragLogic', ({ event, context }) => ({
              ...event,
              panes: context.activeWindowId
                ? context.panes.filter((p) => p.windowId === context.activeWindowId)
                : context.panes,
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
        // Events from Drag Machine — DRAG_STATE_UPDATE handled by layoutState
        // (drag cancel happens via the Escape KEY_PRESS guard inside the
        // drag machine, not a separate event)

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
        // Forward KEY_PRESS to drag and resize machines for Escape handling
        // KEY_PRESS, RESIZE_STATE_UPDATE, RESIZE_COMPLETED — handled by layoutState

        // Pane Operations
        FOCUS_PANE: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            if (context.floatPanes[event.paneId]) {
              // Float pane: update focus tracking only — never call select-pane for float
              // panes as it would switch the active tmux window and hide background panes.
              enqueue(assign({ focusedFloatPaneId: event.paneId }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_FOCUSED_FLOAT' as const,
                  paneId: event.paneId,
                }),
              );
            } else {
              // Regular pane: clear float focus and select the pane normally
              if (context.focusedFloatPaneId) {
                enqueue(assign({ focusedFloatPaneId: null }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_FOCUSED_FLOAT' as const,
                    paneId: null,
                  }),
                );
              }
              // Only send select-pane if the pane isn't already active.
              // Redundant select-pane commands race with relative-target
              // operations like prefix+o (select-pane -t :.+).
              // Dispatch through the STORE (not the tmux actor) so the click
              // gets the SelectPane optimistic prediction — the active
              // highlight must flip on the click, not on the round-trip.
              if (event.paneId !== context.activePaneId) {
                enqueue(
                  sendTo('tmuxStore', {
                    type: 'DISPATCH_COMMAND' as const,
                    command: `select-pane -t ${event.paneId}`,
                  }),
                );
              }
            }
          }),
        },
        SEND_COMMAND: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            const command = resolveWindowTarget(event.command, context.activeWindowId);
            // Match intercepts against the tail after the prefix-pin so
            // bindings like `<prefix> [` (rewritten to
            // `select-pane -t %X \; copy-mode`) still hit the client-side
            // copy-mode path. Forwarding to tmux keeps the original.
            const tail = stripActivePanePrefix(command);

            // Intercept copy-mode — activate client-side copy mode
            if (tail.match(/^copy-mode\b/)) {
              const paneId = context.activePaneId;
              if (paneId) {
                enqueue.raise({ type: 'ENTER_COPY_MODE', paneId });
              }
              return;
            }

            // Intercept command-prompt — enter client-side command mode
            if (tail.match(/^command-prompt\b/)) {
              const parsed = parseCommandPrompt(tail, context);
              enqueue(
                assign({
                  commandMode: {
                    prompt: parsed.prompt,
                    input: parsed.initialValue,
                    template: parsed.template,
                  },
                }),
              );
              return;
            }

            // Intercept display-message (without -p) — show in status bar
            if (tail.match(/^display-message\b/)) {
              const msg = parseDisplayMessage(tail);
              if (msg !== null) {
                enqueue(assign({ statusMessage: { text: msg, timestamp: Date.now() } }));
                enqueue(({ self }) => {
                  setTimeout(() => {
                    self.send({ type: 'CLEAR_STATUS_MESSAGE' });
                  }, STATUS_MESSAGE_DURATION);
                });
                return;
              }
            }

            // Route tab-nav commands through SELECT_TAB. UI menu items fire
            // `next-window`/`previous-window`/`last-window`/`select-window` via
            // SEND_COMMAND; we want the same optimistic flip + pane bookkeeping
            // as window-tab clicks get.
            const tabNavTarget = resolveTabNavTarget(tail, context);
            if (tabNavTarget) {
              enqueue.raise({
                type: 'SELECT_TAB',
                windowId: tabNavTarget.windowId,
                windowIndex: tabNavTarget.windowIndex,
              });
              return;
            }

            // Same treatment for pane-group nav (prev/next) — share the
            // optimistic swap + keyboard re-target path that tab clicks get.
            const groupNavTarget = resolvePaneGroupNavTarget(tail, context);
            if (groupNavTarget) {
              enqueue.raise({
                type: 'SELECT_PANE_GROUP_TAB',
                paneId: groupNavTarget.paneId,
              });
              return;
            }

            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command,
              }),
            );
          }),
        },
        // SEND_KEYS, CLOSE_PANE — handled by layoutState
        // Optimistic pane-group tab switch — mirrors SELECT_TAB so the active
        // tab indicator flips immediately, the visible-window slot shows the
        // clicked pane before tmux's swap-pane round-trips, and the keyboard
        // actor's activePaneId tracks the user's intent (so a Ctrl+C typed
        // right after the click doesn't land in the previously-visible pane).
        SELECT_PANE_GROUP_TAB: {
          actions: enqueueActions(({ event, context, enqueue }) => {
            const clickedPaneId = event.paneId;

            const clickedPane = context.panes.find((p) => p.tmuxId === clickedPaneId);
            if (!clickedPane) return;

            // No-op only when the clicked pane already occupies the visible
            // slot. Comparing against activePaneId alone is not enough: an
            // optimistic focus can stay pinned on a PARKED member (its window
            // is hidden), and that stale pin must not eat the user's click.
            if (
              clickedPaneId === context.activePaneId &&
              clickedPane.windowId === context.activeWindowId
            ) {
              return;
            }

            // Flip the active pane SYNCHRONOUSLY — machine context and keyboard
            // actor both — before any store round-trip. A keystroke fired in the
            // same tick as the click reads its send-keys target from
            // context.activePaneId (via the keyboard actor's snapshot read); if
            // that flip waited for the store's GroupSwitch op to patch `derived`
            // and echo back through TMUX_MODEL_UPDATE, the first character after
            // the click would still carry the previous pane's id and land in the
            // wrong pane. The store op below still owns the visual swap; this
            // only fixes the input target, which cannot afford to wait.
            enqueue(assign({ activePaneId: clickedPaneId }));
            enqueue(
              sendTo('keyboard', {
                type: 'UPDATE_ACTIVE_PANE' as const,
                paneId: clickedPaneId,
              }),
            );

            const group = Object.values(context.paneGroups).find((g) =>
              g.paneIds.includes(clickedPaneId),
            );

            // Find the pane currently occupying the visible window slot for
            // this group (if any) — that's the one swap-pane will swap with.
            const visiblePane = group
              ? (() => {
                  const visibleId = group.paneIds.find((id) => {
                    const p = context.panes.find((pp) => pp.tmuxId === id);
                    return p?.windowId === context.activeWindowId;
                  });
                  return visibleId
                    ? (context.panes.find((p) => p.tmuxId === visibleId) ?? null)
                    : null;
                })()
              : null;

            // No group or no visible peer: no swap bookkeeping, just run the
            // switch command (a no-op in tmux). activePaneId is already flipped
            // above.
            if (!group || !visiblePane || visiblePane.tmuxId === clickedPaneId) {
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-switch ${clickedPaneId}"`,
                }),
              );
              return;
            }

            // Through the STORE: the GroupSwitch op's patch swaps the two
            // panes' window/geometry/active in `derived` immediately, holds
            // the swap over stale pre-confirm snapshots with the confirm
            // linger, and self-neutralizes if either pane disappears —
            // replacing the dim-override freeze and its 500/550/750ms timers
            // (review follow-up #8: one owner per optimistic hold). The
            // post-swap content refresh is the core's job now: window/layout
            // changes queue marker-routed captures for the moved panes.
            enqueue(
              sendTo('tmuxStore', {
                type: 'DISPATCH_OP' as const,
                op: {
                  _tag: 'GroupSwitch' as const,
                  clickedPaneId,
                  visiblePaneId: visiblePane.tmuxId,
                },
                command: `run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-switch ${clickedPaneId}"`,
              }),
            );
          }),
        },
        // SELECT_TAB, ZOOM_PANE, WRITE_TO_PANE — handled by layoutState
        // CLOSE_FLOAT, CLOSE_TOP_FLOAT — handled by groupsAndFloatsIdleEvents

        // Cmd+C / Ctrl+C: copy selection to clipboard or send SIGINT
        COPY_SELECTION: {
          actions: enqueueActions(({ context, enqueue }) => {
            const paneId = context.activePaneId;
            // Check client-side copy mode first
            // (clipboard write is handled by keyboard actor's native copy event)
            if (paneId && context.copyModeStates[paneId]) {
              // Exit copy mode (whether or not there was a selection to copy)
              copyModeExitTimes.set(paneId, Date.now());
              const newStates = { ...context.copyModeStates };
              delete newStates[paneId];
              enqueue(assign({ copyModeStates: newStates }));
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_COMMAND' as const,
                  command: `send-keys -t ${paneId} -X cancel`,
                }),
              );
              return;
            }

            // Not in client-side copy mode: send SIGINT (C-c). Target the
            // focused pane the same way every keyboardActor path does —
            // `focusedFloatPaneId ?? realPaneId(activePaneId) ?? sessionName`.
            // Targeting the session (server-side active pane) delivered C-c to
            // the hidden session-active pane when a float was focused, or to the
            // previous pane right after an optimistic switch.
            const activePane = context.activePaneId;
            const realActivePane =
              activePane && !activePane.startsWith('__placeholder_') ? activePane : null;
            const sigintTarget =
              context.focusedFloatPaneId ?? realActivePane ?? context.sessionName;
            enqueue(
              sendTo('tmux', {
                type: 'SEND_COMMAND' as const,
                command: `send-keys -t ${sigintTarget} C-c`,
              }),
            );
          }),
        },
      },
    },

    /**
     * SSE/Tauri channel dropped and the adapter is retrying. Distinct from
     * `connecting` (cold start, no prior state) so the UI can show a "lost
     * connection, retrying…" banner over the stale layout instead of the
     * full status screen. Only the four handlers below are active: server
     * state still flows in (so the layout stays fresh), but user input is
     * dropped for the duration — see the TMUX_RECONNECTING note above.
     * TMUX_RECONNECTED swaps back to idle once a fresh server snapshot
     * lands, and the store's reconciler runs against pending ops then.
     */
    reconnecting: {
      on: {
        TMUX_RECONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, reconnectAttempt: 0, error: null }),
        },
        TMUX_DISCONNECTED: {
          target: 'disconnected',
          actions: assign({ connected: false, enableAnimations: false }),
        },
        // Still ingest server state during the reconnecting window — when the
        // channel comes back, the first full snapshot triggers reconciliation
        // through the TmuxStore's normal path.
        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_MODEL_UPDATE: {
          actions: assign(({ event }) => {
            const transformed = snapshotFromModel(event.model);
            return {
              panes: transformed.panes,
              windows: transformed.windows,
              activePaneId: transformed.activePaneId,
              activeWindowId: transformed.activeWindowId,
              statusLine: transformed.statusLine,
              totalWidth: transformed.totalWidth,
              totalHeight: transformed.totalHeight,
            };
          }),
        },
      },
    },

    /**
     * Terminal connection state. Reached on TMUX_FATAL (backend gave up) or
     * an explicit TMUX_DISCONNECTED. The status screen reads `fatalError`
     * (set by the global TMUX_FATAL handler) to show a non-recoverable
     * banner. No auto-recovery — the user reloads the page or restarts the
     * server. Live-state handlers (connecting, idle, reconnecting) are
     * intentionally absent so dispatch attempts no-op cleanly.
     */
    disconnected: {
      on: {
        // Adapter may resume on its own (e.g. server restart while page open)
        // — accept the reconnection signal so we re-enter the live branch.
        TMUX_RECONNECTING: {
          target: 'reconnecting',
          actions: assign(({ event }) => ({ reconnectAttempt: event.attempt })),
        },
        TMUX_CONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, fatalError: null, error: null }),
        },
      },
    },
  },
});

export type AppMachine = typeof appMachine;
export type AppMachineActor = ActorRefFrom<typeof appMachine>;
