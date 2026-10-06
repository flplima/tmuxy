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

import { notReadOnly } from './readOnlyGuard';
import {
  setup,
  assign,
  sendTo,
  enqueueActions,
  raise,
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
import { notificationsState } from './states/notifications';
import { notificationsActions } from './actions/notifications';
import { browserState } from './states/browser';
import { browserActions } from './actions/browser';
import { copyModeState } from './states/copyMode';
import { copyModeActions, copyModeExitTimes, reconcilePaneMode } from './actions/copyMode';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from './states/groupsAndFloats';
import { groupsAndFloatsActions } from './actions/groupsAndFloats';
import { layoutState } from './states/layout';
import { askState } from './states/ask';
import { tabOverviewGlobalEvents } from './states/tabOverview';
import { gesturesGlobalEvents } from './states/gestures';
import { gesturesActions } from './actions/gestures';
import { tabOverviewActions } from './actions/tabOverview';
import { layoutActions } from './actions/layout';
import { dispatchActions } from './dispatch';
import { askActions, pruneAskSelections } from './actions/ask';
import { isBoxPermutation, samePanes } from './layoutChange';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../constants';
import { selectLeftSidebarPane, selectRightSidebarPane, visibleFloats } from '../selectors';
import type { TmuxClientModel, TmuxSnapshot } from '../../tmux/store';
import type { TmuxStoreActorEvent } from '../actors/tmuxStoreActor';
import {
  buildGroupsFromPanes,
  buildFloatPanesFromWindows,
  gridExtent,
  keepLivePanes,
} from './helpers';
import { applyFontSize } from '../../utils/fontSizeManager';
import { writeClipboard, clipboardWriteMessage } from '../../utils/clipboard';
import type { CopyModeState } from '../../tmux/types';
import type { CellLine } from '../../domain/wire';

import { dragMachine } from '../drag/dragMachine';
import { resizeMachine } from '../resize/resizeMachine';
import type { KeyboardActorEvent } from '../actors/keyboardActor';
import type { TmuxActorEvent } from '../actors/tmuxActor';
import type { SizeActorEvent } from '../actors/sizeActor';
import type { LinkModifierActorEvent } from '../actors/linkModifierActor';
import type { GestureActorEvent } from '../actors/gestureActor';
import type { ServersActorEvent } from '../actors/serversActor';
import { type PaneId, type WindowId, isPlaceholderId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';

type ResizeGeom = { tmuxId: PaneId; x: number; y: number; width: number; height: number };

/**
 * Whether the server geometry has caught up to the optimistic resize preview's
 * predicted final size (target + neighbors). After a drag ends the preview is
 * held; clearing it the instant ANY server update lands — even a stale
 * intermediate `%layout-change` still in flight from the drag — makes the pane
 * flash back to that intermediate size before the final resize confirms. So we
 * hold the preview until the server matches the prediction, at which point
 * clearing it is invisible. (A never-matching resize, e.g. driven into a min-
 * size clamp, is cleared by the fallback timer in layout_resizeCompleted.)
 */
function resizePreviewSettled(
  resize: NonNullable<AppMachineContext['resize']>,
  panes: ResizeGeom[],
  charWidth: number,
  charHeight: number,
): boolean {
  const dCols = Math.round(resize.pixelDelta.x / charWidth);
  const dRows = Math.round(resize.pixelDelta.y / charHeight);
  const matches = (want: ResizeGeom): boolean => {
    const got = panes.find((p) => p.tmuxId === want.tmuxId);
    return (
      got !== undefined &&
      got.x === want.x &&
      got.y === want.y &&
      got.width === want.width &&
      got.height === want.height
    );
  };
  const op = resize.originalPane;
  const target: ResizeGeom = {
    tmuxId: op.tmuxId,
    x: op.x,
    y: op.y,
    width: op.width,
    height: op.height,
  };
  if (resize.handle === 'e') target.width = Math.max(1, op.width + dCols);
  else if (resize.handle === 'w') {
    target.x = op.x + dCols;
    target.width = Math.max(1, op.width - dCols);
  } else if (resize.handle === 's') target.height = Math.max(1, op.height + dRows);
  else if (resize.handle === 'n') {
    target.y = op.y + dRows;
    target.height = Math.max(1, op.height - dRows);
  }
  if (!matches(target)) return false;
  for (const on of resize.originalNeighbors) {
    const n: ResizeGeom = {
      tmuxId: on.tmuxId,
      x: on.x,
      y: on.y,
      width: on.width,
      height: on.height,
    };
    if (resize.handle === 'e') {
      n.x = on.x + dCols;
      n.width = Math.max(1, on.width - dCols);
    } else if (resize.handle === 'w') n.width = Math.max(1, on.width + dCols);
    else if (resize.handle === 's') {
      n.y = on.y + dRows;
      n.height = Math.max(1, on.height - dRows);
    } else if (resize.handle === 'n') n.height = Math.max(1, on.height + dRows);
    if (!matches(n)) return false;
  }
  return true;
}

/**
 * The store's derived snapshot, widened from its readonly types to the
 * mutable shapes the machine context declares, as a local object a model
 * update can adjust before it is assigned.
 */
function snapshotFromModel(model: TmuxClientModel): {
  panes: TmuxSnapshot['panes'][number][];
  windows: TmuxSnapshot['windows'][number][];
  activePaneId: PaneId | null;
  activeWindowId: WindowId | null;
  totalWidth: number;
  totalHeight: number;
  sessionName: string;
  focusRequest: string;
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
    sessionName: d.sessionName,
    focusRequest: d.focusRequest,
  };
}

/** Move a pane ID to the front of the MRU list */
/** A group member parked out of view: in a group, and not in the window on screen. */
function isParkedMember(context: AppMachineContext, paneId: PaneId): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return !!pane?.groupId && pane.windowId !== context.activeWindowId;
}

function updateActivationOrder(order: PaneId[], paneId: PaneId | null): PaneId[] {
  if (!paneId) return order;
  return [paneId, ...order.filter((id) => id !== paneId)];
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
    linkModifierActor: fromCallback<LinkModifierActorEvent>(() => () => {}),
    gestureActor: fromCallback<GestureActorEvent, { parent: AnyActorRef }>(() => () => {}),
    serversActor: fromCallback<ServersActorEvent, { parent: AnyActorRef }>(() => () => {}),
    dragMachine,
    resizeMachine,
  },
  actions: {
    ...uiPrefsActions,
    ...commandUiActions,
    ...notificationsActions,
    ...copyModeActions,
    ...browserActions,
    ...groupsAndFloatsActions,
    ...tabOverviewActions,
    ...gesturesActions,
    ...layoutActions,
    ...dispatchActions,
    ...askActions,
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
      // The client model: bridges TmuxStore (Effect Ref) into XState.
      // Every routed op (DISPATCH_OP) lands here for optimistic dispatch; TMUX_STATE_UPDATE
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
      // Cmd/Ctrl-held tracking for auto-detected URL affordance; owns no
      // machine state, only a <body> class (see linkModifierActor).
      id: 'linkModifier',
      src: 'linkModifierActor',
    },
    {
      // Trackpad slides and pinches → GESTURE_* (see gestureActor).
      id: 'gestures',
      src: 'gestureActor',
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
    // Each `<name>State.on` slice owns events whose context-field writes
    // are restricted to that slice per FIELD_OWNERS in ./context.ts.
    ...uiPrefsState.on,
    ...commandUiState.on,
    ...notificationsState.on,
    ...groupsAndFloatsGlobalEvents,
    ...tabOverviewGlobalEvents,
    ...gesturesGlobalEvents,

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
    SNAPSHOTS_UPDATED: {
      actions: assign(({ event }) => ({ restorableSessions: event.restorableSessions })),
    },
    // A rebuild runs through the server's own control-mode client and takes
    // a moment; the switch follows its answer (SESSION_SWITCH_REQUESTED), not
    // the click, or the client would attach to a session that is not there yet.
    RESTORE_SESSION: {
      guard: notReadOnly,
      actions: sendTo('tmux', ({ event }) => ({
        type: 'RESTORE_SESSION' as const,
        sessionName: event.sessionName,
      })),
    },
    // The poll idles unless the tree sidebar is open; a menu opened from the
    // status line or the sidebar title asks for one tick, so it never lists
    // sessions or snapshots from before it was last looked at.
    SESSION_MENU_OPENED: {
      actions: sendTo('servers', { type: 'REFRESH_SESSIONS' as const }),
    },
    GIT_REPOSITORIES_UPDATED: {
      actions: assign(({ event }) => ({ repositories: event.repositories })),
    },
    // Saved servers, from the same poll. Desktop only — a web client never
    // receives this, so the switcher shows it no server list.
    SERVERS_UPDATED: {
      actions: assign(({ event }) => ({
        servers: event.servers,
        currentServerId: event.currentServerId,
      })),
    },
    // OSC 52 clipboard write request from a terminal application. Mirror it
    // into the system clipboard via navigator.clipboard. Fire-and-forget —
    // a denied permission shouldn't break the rest of the machine. Updates
    // `lastClipboardWrite` so tests/UI can observe the most recent payload
    // without re-reading the system clipboard.
    //
    // The status message is the SEC-01 signal: the sequence comes from pane
    // OUTPUT, so `cat` of a crafted file can replace what the user is about to
    // paste. The server already drops writes from a background pane and ones
    // over the cap; saying that the clipboard changed is what makes the
    // remaining, legitimate case (an nvim yank over ssh) not silent.
    TMUX_CLIPBOARD: {
      actions: [
        ({ event }) => writeClipboard(event.text, event.paneId),
        raise(({ event }) => ({
          type: 'SHOW_STATUS_MESSAGE' as const,
          text: clipboardWriteMessage(event.text, event.paneId),
        })),
      ],
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
    // events (DISPATCH_OP, SEND_TMUX_COMMAND, KEY_PRESS, FOCUS_PANE, drag/resize) are
    // therefore dropped while the banner is up, which matches the transport
    // being down: there is nothing to send them over. The keyboard actor
    // stays enabled, so keystrokes are swallowed rather than reaching the
    // browser. If we ever want them buffered and flushed on reconnect, that
    // needs an explicit queue, not a handler spread.
    TMUX_RECONNECTING: {
      target: '.reconnecting',
      actions: assign({ connected: false }),
    },
    // Size events (handled globally, in any state)
    SET_CHAR_SIZE: {
      actions: assign(({ event }) => ({
        charWidth: event.charWidth,
        charHeight: event.charHeight,
        cellGap: event.cellGap,
      })),
    },
    SET_TARGET_SIZE: {
      actions: enqueueActions(({ event, context, enqueue }) => {
        // A sliding sidebar column changes the container's width every frame;
        // the grid was sized for where the slide ends when it started (see
        // beginSidebarMotion), so the in-between sizes are noise.
        if (context.sidebarMotion && !event.force) return;
        enqueue(
          assign({
            targetCols: event.cols,
            targetRows: event.rows,
          }),
        );
        // The dock's own row count follows the viewport and the font.
        enqueue.raise({ type: 'SYNC_DOCK_ROWS' as const });

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
        const grid = gridExtent(context.panes, context.activeWindowId, {
          cols: context.totalWidth,
          rows: context.totalHeight,
        });
        const shouldResize =
          !context.readOnly &&
          context.connected &&
          grid.cols > 0 &&
          (event.cols !== grid.cols || event.rows !== grid.rows);
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
    SET_BODY_SIZE: {
      actions: assign(({ event }) => ({ bodyWidth: event.width })),
    },
    OBSERVE_CONTAINER: {
      actions: sendTo('size', ({ event }) => ({
        type: 'OBSERVE_CONTAINER' as const,
        element: event.element,
      })),
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
        readOnly: event.readOnly,
      })),
    },

    // Command mode + status message events — handled by commandUiState

    // Single entry point for tab creation, so the "+" button and tab menu
    // items pick up the same optimistic prediction + reconciliation path that
    // the prefix+c keybinding gets.
    CREATE_TAB: {
      guard: notReadOnly,
      actions: raise({ type: 'DISPATCH_OP', op: TmuxOp.NewWindow() }),
    },

    // Theme events (global — work in any state)
    // Theme + font-size events — handled by uiPrefsState (see spread at end of on:)

    // Attach to a saved server: another socket on this machine, or one reached
    // over SSH. Desktop only — `connect_server` is a Tauri command, and it
    // retargets the live monitor rather than relaunching, so there is no
    // session teardown to do here: the reconnect delivers a fresh snapshot the
    // same way a cold start does.
    CONNECT_SERVER: {
      actions: sendTo('tmux', ({ event }) => ({
        type: 'INVOKE' as const,
        cmd: 'connect_server',
        args: { id: event.serverId },
      })),
    },

    // Save a typed connection. The poll picks the new server up on its next
    // pass, so the switcher lists it without asking for it back.
    ADD_SERVER: {
      actions: sendTo('tmux', ({ event }) => ({
        type: 'INVOKE' as const,
        cmd: 'add_server',
        args: { dest: event.dest, socket: event.socket ?? null },
      })),
    },

    RECONNECT_NOW: {
      actions: sendTo('tmux', { type: 'RECONNECT_NOW' as const }),
    },

    // Detach this client. The tmux server and every session keep running; the
    // user comes back with the switcher.
    DETACH_CLIENT: {
      guard: notReadOnly,
      // Not a bare `detach-client`: the backend must know this was deliberate,
      // or its monitor reattaches on the next pass and the user lands back in
      // the session they just stepped out of.
      actions: sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'detach_client',
      }),
    },

    // The connection ended. `detached` means the user asked for it, so the UI
    // shows the switcher over the blurred layout instead of retrying.
    TMUX_DETACHED: {
      target: '.detached',
      actions: assign({ connected: false, enableAnimations: false }),
    },

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
            browserStates: {},
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
    // OPEN_CONNECT_FLOAT — handled by groupsAndFloatsGlobalEvents
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
        ...browserState.on,
        ...groupsAndFloatsIdleEvents,
        ...layoutState.on,
        ...askState.on,

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

            // ROOT FIX for the "row jumps up a cell" glitch on split / kill /
            // keyboard-resize / layout change / client resize: tmux emits
            // transient intermediate %layout-change events in which an existing
            // pane briefly reports y=0 — the pane-border-status top row
            // momentarily gone — bundled with a compensating +1 height. The
            // outer box is unchanged, but computePaneBox's `headerRows = y > 0`
            // term drops that pane's header and shifts its terminal content up a
            // row for a frame. With pane-border-status top (on for every TAB —
            // enforced by the native monitor and the v86 guest setup) every
            // settled pane in one sits at y>=1: it can only reach y=0
            // transiently while a layout is in flux. So an existing pane
            // reporting y=0 is always that spurious dip — hold its previous
            // geometry; the real y>=1 layout that follows is applied normally.
            // Skip drag-resize, which has its own frozen-band preview.
            //
            // The two sidebars are the windows tmuxy turns that border OFF for
            // (they are drawn headerless and sized without the row), so THEIR
            // panes sit at y=0 for real and must be left alone — folding a
            // header back in would cost them a row of content forever.
            if (!context.resizeActive) {
              const borderlessWindowIds = new Set(
                transformed.windows
                  .filter(
                    (w) => w.windowType === 'sidebar-left' || w.windowType === 'sidebar-right',
                  )
                  .map((w) => w.id),
              );
              transformed.panes = transformed.panes.map((np) => {
                if (np.y !== 0) return np;
                if (borderlessWindowIds.has(np.windowId)) return np;
                const prev = context.panes.find((o) => o.tmuxId === np.tmuxId);
                if (!prev) return np;
                // Only a y=1 (top-row) pane can be shoved to y=0 by the vanishing
                // border row, so the settled y is always 1 (a constant, not the
                // possibly-transient previous value). The server reports the dip
                // as a self-consistent (y=0, h) pair whose computePaneBox box is
                // IDENTICAL to the settled (y=1, h-1) form — the header row is
                // just folded into the height. Restore y=1 and un-fold the height
                // (bringing the header back), keeping the server's x/width so a
                // legitimate resize in the same update survives.
                return { ...np, y: 1, height: Math.max(1, np.height - 1) };
              });
            }

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

            // A dock window that just appeared needs its row count written.
            enqueue.raise({ type: 'SYNC_DOCK_ROWS' as const });

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
                // Window-type flips need to rebuild floats too — a window that
                // arrives initially untagged and later flips to windowType=float
                // (set-option round-trip) must rebuild floatPanes.
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
                  Boolean(w.sidebarHidden) !== Boolean(prev.sidebarHidden) ||
                  Boolean(w.zoomed) !== Boolean(prev.zoomed)
                ) {
                  return true;
                }
                return false;
              }) ||
              // A pane changing window (group swap), its group id (join/leave/
              // degroup) or its place in the group (reorder) must rebuild
              // paneGroups.
              transformed.panes.some((p) => {
                const prev = context.panes.find((cp) => cp.tmuxId === p.tmuxId);
                return (
                  p.windowId !== prev?.windowId ||
                  (p.groupId ?? null) !== (prev?.groupId ?? null) ||
                  (p.groupPos ?? null) !== (prev?.groupPos ?? null)
                );
              });

            let paneGroups = structurallyChanged
              ? buildGroupsFromPanes(transformed.panes)
              : context.paneGroups;

            // Prune stale groups: if a group references pane IDs that no longer
            // exist in the updated pane list, remove those IDs. Drop groups that
            // become empty or have only one pane (no longer a group).
            if (!structurallyChanged && Object.keys(paneGroups).length > 0) {
              const paneIdSet = new Set(transformed.panes.map((p) => p.tmuxId));
              const pruned: typeof paneGroups = {};
              let changed = false;
              for (const group of Object.values(paneGroups)) {
                const validIds = group.paneIds.filter((id) => paneIdSet.has(id));
                if (validIds.length >= 2) {
                  pruned[group.id] =
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
            floatPanes = keepLivePanes(floatPanes, currentPaneIdSet);

            // Detect float removal — check for session switch env var
            const prevFloatCount = Object.keys(context.floatPanes).length;
            const newFloatCount = Object.keys(floatPanes).length;
            if (!context.readOnly && prevFloatCount > 0 && newFloatCount < prevFloatCount) {
              enqueue(sendTo('tmux', { type: 'CHECK_SESSION_SWITCH' as const }));
            }

            // Auto-focus float management, over the floats of the tab in front
            // of the user — a float belonging to another tab is off screen, and
            // keys typed at this tab must not disappear into it:
            // - one came into view (opened, or its tab came back): focus it
            // - the focused one left (killed, or its tab did): focus the next
            //   visible float, else hand the keyboard back to the panes
            const visibleFloatIds = visibleFloats(
              floatPanes,
              transformed.windows,
              transformed.activeWindowId,
            ).map((f) => f.paneId);
            const prevVisibleFloatIds = visibleFloats(
              context.floatPanes,
              context.windows,
              context.activeWindowId,
            ).map((f) => f.paneId);
            const addedFloatIds = visibleFloatIds.filter((id) => !prevVisibleFloatIds.includes(id));
            let newFocusedFloat = context.focusedFloatPaneId;
            if (addedFloatIds.length > 0) {
              // Topmost = last in list
              newFocusedFloat = visibleFloatIds[visibleFloatIds.length - 1];
              // Suppress layout animation: the split-window → break-pane
              // workaround creates a momentary extra pane in the active window
              // before it becomes a float. Disabling animation prevents the blink.
              enqueue(assign({ enableAnimations: false }));
            } else if (newFocusedFloat && !visibleFloatIds.includes(newFocusedFloat)) {
              newFocusedFloat =
                visibleFloatIds.length > 0 ? visibleFloatIds[visibleFloatIds.length - 1] : null;
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

            // Sidebar lifecycle. Each column's pane lives outside the active
            // window, so nothing else in this handler notices it coming or
            // going.
            //  - it appeared: show the column. Both columns are session-wide, so
            //    a reload or a second client is supposed to find one already
            //    there — its window existing IS the open state. Only take the
            //    keyboard when this client asked for it (the toggle is already
            //    open), never on a plain page load;
            //  - it vanished (the user ran `exit`, or killed it elsewhere):
            //    retract the column instead of leaving an empty one docked.
            const nextSidebarCtx = {
              ...context,
              windows: transformed.windows,
              panes: transformed.panes,
            };

            //  - the user closed it (here or in another client): its window
            //    carries `@tmuxy-sidebar-hidden` and the pane lives on, so the
            //    open flag follows the flag, not the window's existence.
            const sidebarHidden = (ctx: typeof context, side: 'left' | 'right') =>
              Boolean(ctx.windows.find((w) => w.windowType === `sidebar-${side}`)?.sidebarHidden);

            const prevTreePane = selectLeftSidebarPane(context);
            const nextTreePane = selectLeftSidebarPane(nextSidebarCtx);
            const nextTreeHidden = sidebarHidden(nextSidebarCtx, 'left');
            if (!prevTreePane && nextTreePane) {
              const requestedByThisClient = context.leftSidebarOpen;
              enqueue(assign({ leftSidebarOpen: !nextTreeHidden, leftSidebarStartFailed: false }));
              if (requestedByThisClient && !nextTreeHidden) {
                // Through the focus action, which owns "only one surface holds
                // the keyboard" — assigning the flag here would leave the other
                // column focused too.
                enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' });
                // Same blink as a float: split-window → break-pane parks a pane
                // in the active window for a beat before it moves out.
                enqueue(assign({ enableAnimations: false }));
              }
            } else if (prevTreePane && !nextTreePane) {
              // A pane that dies while this client is still waiting for it to
              // start (the command exited at once) is a failed start, not the
              // user closing the column: keep the column and say what happened.
              const failedStart = context.leftSidebarStarting;
              enqueue(
                assign({
                  leftSidebarOpen: failedStart,
                  leftSidebarFocused: false,
                  leftSidebarStartFailed: failedStart,
                  leftSidebarStarting: false,
                }),
              );
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const,
                  focused: false,
                }),
              );
            } else if (
              prevTreePane &&
              nextTreePane &&
              sidebarHidden(context, 'left') !== nextTreeHidden
            ) {
              enqueue(assign({ leftSidebarOpen: !nextTreeHidden }));
              if (nextTreeHidden && context.leftSidebarFocused) {
                enqueue(assign({ leftSidebarFocused: false }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const,
                    focused: false,
                  }),
                );
              }
            }

            const prevDockPane = selectRightSidebarPane(context);
            const nextDockPane = selectRightSidebarPane(nextSidebarCtx);
            const nextDockHidden = sidebarHidden(nextSidebarCtx, 'right');
            if (!prevDockPane && nextDockPane) {
              const requestedByThisClient = context.rightSidebarOpen;
              enqueue(
                assign({ rightSidebarOpen: !nextDockHidden, rightSidebarStartFailed: false }),
              );
              if (requestedByThisClient && !nextDockHidden) {
                enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
                enqueue(assign({ enableAnimations: false }));
              }
            } else if (prevDockPane && !nextDockPane) {
              const failedStart = context.rightSidebarStarting;
              enqueue(
                assign({
                  rightSidebarOpen: failedStart,
                  rightSidebarFocused: false,
                  rightSidebarStartFailed: failedStart,
                  rightSidebarStarting: false,
                }),
              );
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const,
                  paneId: null,
                }),
              );
            } else if (
              prevDockPane &&
              nextDockPane &&
              sidebarHidden(context, 'right') !== nextDockHidden
            ) {
              enqueue(assign({ rightSidebarOpen: !nextDockHidden }));
              if (nextDockHidden && context.rightSidebarFocused) {
                enqueue(assign({ rightSidebarFocused: false }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const,
                    paneId: null,
                  }),
                );
              }
            }

            // A dragged width the server has now echoed back: the preview has
            // done its job, the window's own value takes over.
            const preview = context.sidebarColsPreview;
            if (preview) {
              const win = nextSidebarCtx.windows.find(
                (w) => w.windowType === `sidebar-${preview.side}`,
              );
              if (win && (win.sidebarCols ?? null) === preview.cols) {
                enqueue(assign({ sidebarColsPreview: null }));
              }
            }

            // A focus request queued by a shell helper (`tmuxy nav left/right`
            // at the edge of the grid). Focusing a column is client-side — its
            // pane is in another window, so `select-pane` would switch the
            // visible tab — so the script publishes the intent as a session
            // option and we act on it here, then clear it so the next poll
            // doesn't replay it. Acting is idempotent, which is what makes the
            // window between the two harmless.
            if (transformed.focusRequest && !context.readOnly) {
              const request = transformed.focusRequest;
              if (request === 'left') enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' });
              else if (request === 'right') enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
              else if (request === 'panes') {
                enqueue.raise({ type: 'BLUR_LEFT_SIDEBAR' });
                enqueue.raise({ type: 'BLUR_RIGHT_SIDEBAR' });
              }
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_OP' as const,
                  op: TmuxOp.ClearFocusRequest({ session: context.sessionName }),
                }),
              );
            }

            // Reconcile each pane's reported mode with the client's record for it
            // (`reconcilePaneMode` says why the order of events matters here).
            let updatedCopyModeStates = context.copyModeStates;
            const now = Date.now();
            for (const newPane of transformed.panes) {
              const prevPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
              const record = context.copyModeStates[newPane.tmuxId];
              switch (
                reconcilePaneMode(prevPane, newPane, record, { readOnly: context.readOnly, now })
              ) {
                case 'confirm': {
                  updatedCopyModeStates = {
                    ...updatedCopyModeStates,
                    [newPane.tmuxId]: { ...record, tmuxSeen: true },
                  };
                  break;
                }
                case 'leave': {
                  updatedCopyModeStates = { ...updatedCopyModeStates };
                  delete updatedCopyModeStates[newPane.tmuxId];
                  break;
                }
                case 'enter': {
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
                    // tmux reported `in_mode`, so this is its copy mode, with a
                    // cursor and vi keys — never the client-only scroll view.
                    mode: 'copy',
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
                    tmuxSeen: true,
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
                  break;
                }
                case 'none':
                  break;
              }
            }

            // Prune copy mode state for panes that no longer exist — e.g. the
            // user closed a pane while it was in copy mode. Keyboard copy-mode
            // routing is derived from copyModeStates[activePaneId], so leaving a
            // stale entry could keep keys routed to a dead pane's copy mode
            // during the brief window before activePaneId moves to a live pane.
            updatedCopyModeStates = keepLivePanes(updatedCopyModeStates, currentPaneIdSet);

            // Same for browser widget state. tmux hands out pane ids from a
            // counter that starts again when the server does, so a stale
            // record left behind by a closed pane could be inherited by an
            // unrelated pane after a restart — and its history cursor would
            // point the new pane's browser at a page that was never opened.
            const updatedBrowserStates = keepLivePanes(context.browserStates, currentPaneIdSet);

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

            // Hold the optimistic resize preview during the drag AND after
            // release until the server geometry has STABLY caught up to the
            // preview's prediction — i.e. this update matches the prediction
            // AND is the SECOND consecutive quiet update (the oscillating
            // burst has truly stopped, not a momentary repeat). A fast drag
            // makes tmux emit a burst of oscillating %layout-change events
            // after mouse-up; clearing on the first match lets a later stale
            // one flash through (the pane wobbles a row), and clearing on the
            // first update flashes back to an intermediate size. Masking until
            // the burst settles avoids both. A never-settling resize (e.g.
            // driven into a min-size clamp) is cleared by the fallback timer
            // in layout_resizeCompleted.
            const heldResize =
              context.resizeActive ||
              (context.resize !== null &&
                !(
                  !hasDimensionChange &&
                  context.lastUpdateQuiet &&
                  resizePreviewSettled(
                    context.resize,
                    transformed.panes,
                    context.charWidth,
                    context.charHeight,
                  )
                ))
                ? context.resize
                : null;

            // Panes changing SIZE — a resize landing, a stack opening the row
            // the focus moved to — animate: the eye can follow the boxes
            // growing, and a jump cut reads as a glitch. Everything else keeps
            // snapping, and each exclusion is a way the animation would be
            // wrong rather than merely unnecessary:
            //
            //  - a swap is a permutation of the same boxes, and animating it
            //    slides the two panes through each other;
            //  - a split or a kill changes the pane set, and owns a morph of
            //    its own (the enter/leave lifecycle in PaneLayout);
            //  - a drag resize is already following the pointer exactly, and
            //    its post-release burst is a stream of inconsistent boxes;
            //  - an update arriving on the heels of another dirty one is one
            //    frame of a burst, not a change anybody asked to watch.
            const animateGeometry =
              hasDimensionChange &&
              context.lastUpdateQuiet &&
              heldResize === null &&
              samePanes(context.panes, transformed.panes) &&
              !isBoxPermutation(context.panes, transformed.panes);

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
              if (!context.readOnly && pane.active && pane.windowId) {
                lastActivePaneByWindow[pane.windowId] = pane.tmuxId;
              }
            }

            enqueue(
              assign(({ context: ctx, event: ev }) => ({
                ...transformed,
                activePaneId: effectiveActivePaneId,
                paneGroups,
                floatPanes,
                // A question that has gone away takes its Yes/No highlight
                // with it, so a pane asked a second time starts on `yes`
                // rather than on the answer the user hovered over last time.
                askSelections: pruneAskSelections({ ...ctx, panes: transformed.panes }),
                copyModeStates: updatedCopyModeStates,
                browserStates: updatedBrowserStates,
                resize: heldResize,
                // Derived, no debounce timer: the flag rides the same React
                // commit as the new geometry. A change we chose to animate
                // lifts it; everything else still snaps, and the quiet update
                // that follows a snap keeps it on, because a dirty optimistic
                // update and its instant quiet confirm can batch into one
                // commit and the batch's net geometry delta would animate.
                // After an animated change that same quiet update must NOT
                // re-latch it, or the transition would be cut off a frame in.
                suppressLayoutTransition: animateGeometry
                  ? false
                  : hasDimensionChange || (!ctx.lastUpdateQuiet && !ctx.lastUpdateAnimated),
                lastUpdateQuiet: !hasDimensionChange,
                lastUpdateAnimated: animateGeometry,
                // Panes involved in in-flight GroupSwitch ops — mirrored
                // from the store's op log so selectGroupSwitchPaneIds can
                // suppress CSS transitions on the swapped panes without
                // any machine-side timers.
                groupSwitchPaneIds: ev.model.ops.flatMap((pendingOp) =>
                  pendingOp.op._tag === 'GroupSwitch' && pendingOp.op.visiblePaneId
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
            // client size (uses refresh-client -C for window-size smallest).
            // Compared against the active window's own extent: a hidden
            // window at another size would otherwise keep this true forever
            // — and animations off with it, since they wait for the resize.
            const grid = gridExtent(transformed.panes, transformed.activeWindowId, {
              cols: transformed.totalWidth,
              rows: transformed.totalHeight,
            });
            const shouldResize =
              !context.readOnly &&
              context.targetCols > 0 &&
              context.targetRows > 0 &&
              (context.targetCols !== grid.cols || context.targetRows !== grid.rows);
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
        // While connected an error is the user's to read and dismiss (the
        // snackbar). `error` stays what the connection overlay shows while
        // connecting, so a rejected command is not repeated under the
        // spinner if the channel drops later.
        TMUX_ERROR: {
          actions: raise(({ event }) => ({ type: 'NOTIFY' as const, text: event.error })),
        },
        TMUX_DISCONNECTED: {
          target: 'disconnected',
          actions: assign({ connected: false, enableAnimations: false }),
        },

        SEND_TMUX_COMMAND: { actions: 'dispatch_command' },
        DISPATCH_OP: { actions: 'dispatch_op' },
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
          guard: notReadOnly,
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
                  tabDrop: null,
                  groupDrop: null,
                  memberDrag: isParkedMember(context, event.paneId),
                  leaveSide: null,
                },
              };
            }),
            sendTo('dragLogic', ({ event, context }) => {
              const pane = context.panes.find((p) => p.tmuxId === event.paneId);
              return {
                ...event,
                panes: context.activeWindowId
                  ? context.panes.filter((p) => p.windowId === context.activeWindowId)
                  : context.panes,
                activePaneId: context.activePaneId,
                charWidth: context.charWidth,
                charHeight: context.charHeight,
                containerWidth: context.containerWidth,
                containerHeight: context.containerHeight,
                // A drop into a new tab is a break-pane, which tmux refuses
                // for the only pane in a window — so the machine has to know
                // how many the source window holds.
                paneWindowId: pane?.windowId ?? null,
                panesInWindow: pane
                  ? context.panes.filter((p) => p.windowId === pane.windowId).length
                  : 0,
                groups: context.paneGroups,
                memberDrag: isParkedMember(context, event.paneId),
              };
            }),
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
          guard: notReadOnly,
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
            // The dock's pane is reached through the column's own focus, never
            // `select-pane` — that would switch the active window and blank the
            // tab. Its mouse handlers send FOCUS_PANE like any pane's do.
            if (selectRightSidebarPane(context)?.tmuxId === event.paneId) {
              enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
              return;
            }
            // Exactly one surface holds the keyboard: taking it for a float or a
            // tiled pane releases the tree column too (its focus used to survive
            // a click on a pane, trapping every key the user typed next).
            if (context.leftSidebarFocused) {
              enqueue(assign({ leftSidebarFocused: false }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const,
                  focused: false,
                }),
              );
            }
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
              if (context.rightSidebarFocused) {
                enqueue(assign({ rightSidebarFocused: false }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const,
                    paneId: null,
                  }),
                );
              }
            } else {
              // Regular pane: clear any overlay focus and select the pane
              // normally. Both overlays hold the keyboard away from the grid,
              // so clicking a tiled pane has to release whichever one had it.
              if (context.focusedFloatPaneId) {
                enqueue(assign({ focusedFloatPaneId: null }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_FOCUSED_FLOAT' as const,
                    paneId: null,
                  }),
                );
              }
              if (context.rightSidebarFocused) {
                enqueue(assign({ rightSidebarFocused: false }));
                enqueue(
                  sendTo('keyboard', {
                    type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const,
                    paneId: null,
                  }),
                );
              }
              // Only send select-pane if the pane isn't already active and
              // belongs to the active window. Panes in stash windows (e.g. parked
              // group members) must never receive select-pane directly.
              // Redundant select-pane commands race with relative-target
              // operations like prefix+o (select-pane -t :.+).
              // Dispatch through the STORE (not the tmux actor) so the click
              // gets the SelectPane optimistic prediction — the active
              // highlight must flip on the click, not on the round-trip.
              const targetPane = context.panes.find((p) => p.tmuxId === event.paneId);
              const inActiveWindow = targetPane?.windowId === context.activeWindowId;
              if (event.paneId !== context.activePaneId && inActiveWindow) {
                enqueue(
                  sendTo('tmuxStore', {
                    type: 'DISPATCH_OP' as const,
                    op: TmuxOp.SelectPane({ paneId: event.paneId }),
                  }),
                );
              }
            }
          }),
        },
        // SEND_KEYS, CLOSE_PANE — handled by layoutState
        // Optimistic pane-group tab switch — mirrors SELECT_TAB so the active
        // tab indicator flips immediately, the visible-window slot shows the
        // clicked pane before tmux's swap-pane round-trips, and the keyboard
        // actor's activePaneId tracks the user's intent (so a Ctrl+C typed
        // right after the click doesn't land in the previously-visible pane).
        SELECT_PANE_GROUP_TAB: {
          guard: notReadOnly,
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

            // Clear any overlay focus so clicking a group tab cleanly targets the grid
            if (context.leftSidebarFocused) {
              enqueue(assign({ leftSidebarFocused: false }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const,
                  focused: false,
                }),
              );
            }
            if (context.focusedFloatPaneId) {
              enqueue(assign({ focusedFloatPaneId: null }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_FOCUSED_FLOAT' as const,
                  paneId: null,
                }),
              );
            }
            if (context.rightSidebarFocused) {
              enqueue(assign({ rightSidebarFocused: false }));
              enqueue(
                sendTo('keyboard', {
                  type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const,
                  paneId: null,
                }),
              );
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
                  type: 'SEND_OP' as const,
                  op: TmuxOp.GroupSwitch({ clickedPaneId, visiblePaneId: null }),
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
                op: TmuxOp.GroupSwitch({ clickedPaneId, visiblePaneId: visiblePane.tmuxId }),
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
              // A selection is a copy: it blinks and closes like a yank.
              if (context.copyModeStates[paneId].selectionMode) {
                enqueue.raise({ type: 'COPY_MODE_YANK', paneId });
                return;
              }
              // Nothing selected: just exit copy mode
              copyModeExitTimes.set(paneId, Date.now());
              const newStates = { ...context.copyModeStates };
              delete newStates[paneId];
              enqueue(assign({ copyModeStates: newStates }));
              enqueue(
                sendTo('tmux', {
                  type: 'SEND_OP' as const,
                  op: TmuxOp.CancelCopyMode({ paneId }),
                }),
              );
              return;
            }

            // Not in client-side copy mode: send SIGINT (C-c). Target the
            // focused pane the same way every keyboardActor path does —
            // focused overlay (float, else the pinned dock) ?? active pane ??
            // session. Targeting the session (server-side active pane)
            // delivered C-c to the hidden session-active pane when an overlay
            // was focused, or to the previous pane right after an optimistic
            // switch.
            const activePane = context.activePaneId;
            const realActivePane = activePane && !isPlaceholderId(activePane) ? activePane : null;
            const dockPane = context.rightSidebarFocused
              ? (selectRightSidebarPane(context)?.tmuxId ?? null)
              : null;
            const sigintTarget =
              context.focusedFloatPaneId ?? dockPane ?? realActivePane ?? context.sessionName;
            enqueue(
              sendTo('tmux', {
                type: 'SEND_OP' as const,
                op: TmuxOp.SendKeys({ target: sigintTarget, keys: 'C-c' }),
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
          actions: assign({ connected: true, error: null }),
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
              totalWidth: transformed.totalWidth,
              totalHeight: transformed.totalHeight,
            };
          }),
        },
      },
    },

    /**
     * The user detached. Distinct from `reconnecting` (which retries) and from
     * `disconnected` (which is terminal): the tmux server and every session are
     * still running, and stepping back in is a deliberate act.
     *
     * The layout stays mounted underneath so the overlay blurs the session the
     * user just left, with the switcher on top. The three events below are the
     * ways out — attaching to a server, switching session, or the backend
     * reporting a connection again after a revive.
     */
    detached: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, error: null }),
        },
        // What a reattach actually looks like. TMUX_CONNECTED fires once, from
        // the tmux actor's initial `connect()`, so it never comes again for a
        // monitor that parked and revived — the adapter reports the revival as
        // a recovery instead, once server state starts flowing.
        TMUX_RECONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, error: null }),
        },
        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_RECONNECTING: { target: 'reconnecting' },
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
        TMUX_RECONNECTING: { target: 'reconnecting' },
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
