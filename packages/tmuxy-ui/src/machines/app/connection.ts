/**
 * Global connection, viewport sizing, session management, and clipboard
 * handlers for appMachine.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from './actionTypes';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../constants';
import { PHONE_COLS, PHONE_ROWS } from '../../infra/dom/phoneLayout';
import { fittedGridCell, gridExtent, takeKeyboard } from './helpers';
import { PANES_OWN_KEYBOARD } from '../selectors/keyboard';
import { fixedGridSize } from '../../domain/gridFit';
import { writeClipboard, clipboardWriteMessage } from '../../infra/clipboard';
import { TmuxOp } from '../../domain/commands';
import { memorableSessionName } from '../../domain/sessionNames';
import { isTauri } from '../../infra/platform';

export const connectionGlobalEvents = {
  LOG_APPEND: { actions: 'connection_logAppend' },
  SESSIONS_UPDATED: { actions: 'connection_sessionsUpdated' },
  SNAPSHOTS_UPDATED: { actions: 'connection_snapshotsUpdated' },
  RESTORE_SESSION: {
    actions: 'connection_restoreSession',
  },
  SESSION_MENU_OPENED: {
    actions: 'connection_sessionMenuOpened',
  },
  GIT_REPOSITORIES_UPDATED: { actions: 'connection_gitRepositoriesUpdated' },
  SERVERS_UPDATED: { actions: 'connection_serversUpdated' },
  TMUX_CLIPBOARD: { actions: 'connection_tmuxClipboard' },
  SET_CHAR_SIZE: { actions: 'connection_setCharSize' },
  REFIT_GRID: { actions: 'connection_refitGrid' },
  SET_PHONE_LAYOUT: { actions: 'connection_setPhoneLayout' },
  SET_TARGET_SIZE: { actions: 'connection_setTargetSize' },
  SET_CONTAINER_SIZE: { actions: 'connection_setContainerSize' },
  SET_BODY_SIZE: { actions: 'connection_setBodySize' },
  OBSERVE_CONTAINER: {
    actions: 'connection_observeContainer',
  },
  APP_FOCUS: {
    actions: 'connection_appFocus',
  },
  APP_BLUR: {
    actions: 'connection_appBlur',
  },
  CONNECTION_INFO: { actions: 'connection_connectionInfo' },
  CREATE_TAB: {
    actions: 'connection_createTab',
  },
  CONNECT_SERVER: {
    actions: 'connection_connectServer',
  },
  RECONNECT_NOW: {
    actions: 'connection_reconnectNow',
  },
  DETACH_CLIENT: {
    actions: 'connection_detachClient',
  },
  SWITCH_SESSION: { actions: 'connection_switchSession' },
  NEW_SESSION: { actions: 'connection_newSession' },
} as const;

/** What every freshly opened stream asks the server for. */
function fetchThemes(enqueue: EnqueueAction): void {
  enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
  enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));
}

/** The state at this client's viewport, once one has been computed. */
function fetchStateAtViewport(context: Ctx, enqueue: EnqueueAction): void {
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
}

export const connectionActions = {
  connection_logAppend: assignCtx(({ context, event }) => {
    if (event.type !== 'LOG_APPEND') return {};
    const entry = {
      timestamp: Date.now(),
      kind: event.kind,
      message: event.message,
    };
    const next =
      context.log.length >= 500 ? [...context.log.slice(-499), entry] : [...context.log, entry];
    return { log: next };
  }),

  connection_sessionsUpdated: assignCtx(({ event }) =>
    event.type === 'SESSIONS_UPDATED' ? { sessions: event.sessions } : {},
  ),

  connection_snapshotsUpdated: assignCtx(({ event }) =>
    event.type === 'SNAPSHOTS_UPDATED' ? { restorableSessions: event.restorableSessions } : {},
  ),

  connection_restoreSession: act(({ event, enqueue }) => {
    if (event.type !== 'RESTORE_SESSION') return;
    enqueue(
      sendTo('tmux', {
        type: 'RESTORE_SESSION' as const,
        sessionName: event.sessionName,
      }),
    );
  }),

  connection_sessionMenuOpened: act(({ enqueue }) => {
    enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
  }),

  connection_gitRepositoriesUpdated: assignCtx(({ event }) =>
    event.type === 'GIT_REPOSITORIES_UPDATED' ? { repositories: event.repositories } : {},
  ),

  connection_serversUpdated: assignCtx(({ event }) =>
    event.type === 'SERVERS_UPDATED'
      ? { servers: event.servers, currentServerId: event.currentServerId }
      : {},
  ),

  connection_tmuxClipboard: act(({ event, enqueue }) => {
    if (event.type !== 'TMUX_CLIPBOARD') return;
    enqueue(() => void writeClipboard(event.text, event.paneId));
    enqueue.raise({
      type: 'SHOW_STATUS_MESSAGE' as const,
      text: clipboardWriteMessage(event.text, event.paneId),
    });
  }),

  connection_setCharSize: assignCtx(({ context, event }) => {
    if (event.type !== 'SET_CHAR_SIZE') return {};
    const measuredCell = {
      charWidth: event.charWidth,
      charHeight: event.charHeight,
      cellGap: event.cellGap,
      gridFontSize: event.gridFontSize ?? null,
    };
    return { measuredCell, ...fittedGridCell({ ...context, measuredCell }) };
  }),

  /** The grid's cell, fitted again: the size policy or the window's size changed. */
  connection_refitGrid: assignCtx(({ context }) => fittedGridCell(context)),

  connection_setPhoneLayout: assignCtx(({ event }) =>
    event.type === 'SET_PHONE_LAYOUT'
      ? { phoneLayout: event.phone, phoneLandscape: event.phone && event.landscape }
      : {},
  ),

  connection_setTargetSize: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_TARGET_SIZE') return;
    // A fixed `@tmuxy-size` is what every client asks for, whatever its
    // container measures: the grid keeps its cols/rows and the cell is
    // fitted to it instead (domain/gridFit.ts).
    const fixed = context.phoneLayout ? null : fixedGridSize(context.sizePolicy);
    const cols = context.phoneLayout ? PHONE_COLS : (fixed?.cols ?? event.cols);
    const rows = context.phoneLayout ? PHONE_ROWS : (fixed?.rows ?? event.rows);
    enqueue(
      assign({
        targetCols: cols,
        targetRows: rows,
      }),
    );
    enqueue.raise({ type: 'SYNC_DOCK_SIZE' as const });

    const needsInitialFetch = context.connected && context.panes.length === 0;
    if (needsInitialFetch) {
      enqueue(
        sendTo('tmux', {
          type: 'FETCH_INITIAL_STATE' as const,
          cols,
          rows,
        }),
      );
    }

    const grid = gridExtent(context.panes, context.activeWindowId, {
      cols: context.totalWidth,
      rows: context.totalHeight,
    });
    const shouldResize =
      context.connected && grid.cols > 0 && (cols !== grid.cols || rows !== grid.rows);
    if (shouldResize) {
      enqueue(
        sendTo('tmux', {
          type: 'INVOKE' as const,
          cmd: 'set_client_size',
          args: { cols, rows },
        }),
      );
    } else if (grid.cols > 0 && !context.enableAnimations && context.lastUpdateQuiet) {
      // The grid is already the size this client measured, and quiet: the
      // gate the next update would open (reconcileModelUpdate). With nothing
      // to resize, an idle session may send no update to open it.
      enqueue(assign({ enableAnimations: true }));
    }
  }),

  connection_setContainerSize: assignCtx(({ context, event }) => {
    if (event.type !== 'SET_CONTAINER_SIZE') return {};
    const container = { containerWidth: event.width, containerHeight: event.height };
    return { ...container, ...fittedGridCell({ ...context, ...container }) };
  }),

  connection_setBodySize: assignCtx(({ event }) =>
    event.type === 'SET_BODY_SIZE' ? { bodyWidth: event.width } : {},
  ),

  connection_observeContainer: act(({ event, enqueue }) => {
    if (event.type !== 'OBSERVE_CONTAINER') return;
    enqueue(
      sendTo('size', {
        type: 'OBSERVE_CONTAINER' as const,
        element: event.element,
      }),
    );
  }),

  connection_appFocus: assignCtx({ appFocused: true }),

  connection_appBlur: assignCtx({ appFocused: false }),

  connection_connectionInfo: act(({ event, enqueue }) => {
    if (event.type !== 'CONNECTION_INFO') return;
    enqueue(assign({ defaultShell: event.defaultShell, serverHostname: event.hostname }));
    enqueue(() => {
      if (typeof document !== 'undefined' && !isTauri() && event.hostname) {
        document.title = `tmuxy on ${event.hostname}`;
      }
    });
  }),

  connection_createTab: act(({ enqueue }) => {
    enqueue.raise({ type: 'DISPATCH_OP' as const, op: TmuxOp.NewWindow() });
  }),

  connection_connectServer: act(({ event, enqueue }) => {
    if (event.type !== 'CONNECT_SERVER') return;
    // The server list is only re-read when the sidebar or the session menu is
    // open, so without this the host label keeps naming the old server until
    // one of them next opens. A refresh that finds the connect failed corrects it.
    enqueue(assign({ currentServerId: event.serverId }));
    enqueue(
      sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'connect_server',
        args: { id: event.serverId, session: event.session ?? null },
      }),
    );
  }),

  connection_reconnectNow: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'RECONNECT_NOW' as const }));
  }),

  connection_detachClient: act(({ enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'detach_client',
      }),
    );
  }),

  // Create a session AND switch to it, so the action has a visible effect. On
  // web the switch reconnects with ?session=<name>, and the server's attach
  // creates the session if the create has not landed yet; on Tauri the create
  // must precede switch-client, which the two raised events keep in order. The
  // name is one no session in the last poll has, nor the attached one, nor a
  // snapshot the switcher offers to restore (a session made under a snapshot's
  // name would be saved over it).
  connection_newSession: act(({ context, enqueue }) => {
    const sessionName = memorableSessionName([
      context.sessionName,
      ...context.sessions.map((session) => session.sessionName),
      ...context.restorableSessions.map((session) => session.name),
    ]);
    enqueue.raise({ type: 'DISPATCH_OP' as const, op: TmuxOp.NewSession({ name: sessionName }) });
    enqueue.raise({ type: 'SWITCH_SESSION' as const, sessionName });
  }),

  connection_switchSession: act(({ event, enqueue }) => {
    if (event.type !== 'SWITCH_SESSION') return;
    // Pane ids are server-global: a float or column of the old session that
    // still held the keyboard would keep taking the keystrokes typed into the
    // new one, so every surface lets go here.
    takeKeyboard(enqueue, PANES_OWN_KEYBOARD);
    enqueue(
      assign({
        panes: [],
        windows: [],
        floatPanes: {},
        paneGroups: {},
        activeWindowId: null,
        activePaneId: null,
        sessionName: event.sessionName,
        error: null,
        copyModeStates: {},
        enableAnimations: false,
      }),
    );
    enqueue(sendTo('tmuxStore', { type: 'CLEAR' as const }));
    enqueue(
      sendTo('tmux', {
        type: 'SWITCH_SESSION' as const,
        sessionName: event.sessionName,
      }),
    );
    enqueue(() => {
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('session', event.sessionName);
        window.history.pushState({}, '', url.toString());
      }
    });
  }),

  // The size actor answers CONNECTED by sending the target size again, and
  // that SET_TARGET_SIZE is what fetches the initial state (once, at the size
  // the client measured).
  connection_onConnected: act(({ enqueue }) => {
    enqueue(assign({ connected: true, error: null }));
    enqueue(sendTo('size', { type: 'CONNECTED' as const }));
    fetchThemes(enqueue);
  }),

  // A reconnect fetches the state too: the stream that came back may belong
  // to a restarted server whose monitor another tab already synced, and an
  // idle session then sends nothing on its own — this tab would keep its
  // last frame until a keystroke. The sequencer reopened on the new stream,
  // so the answer is adopted as the starting state.
  connection_onReconnected: act(({ context, enqueue }) => {
    enqueue(assign({ connected: true, error: null }));
    fetchThemes(enqueue);
    fetchStateAtViewport(context, enqueue);
  }),

  connection_keybindingsReceived: assignCtx(({ event }) =>
    event.type === 'KEYBINDINGS_RECEIVED' ? { keybindings: event.keybindings } : {},
  ),
};
