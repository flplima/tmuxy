/**
 * Global connection, viewport sizing, session management, and clipboard
 * handlers for appMachine.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from './actionTypes';
import { notReadOnly } from './readOnlyGuard';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../constants';
import { PHONE_COLS, PHONE_ROWS } from '../../utils/phoneLayout';
import { gridExtent } from './helpers';
import { writeClipboard, clipboardWriteMessage } from '../../utils/clipboard';
import { TmuxOp } from '../../domain/commands';

export const connectionGlobalEvents = {
  LOG_APPEND: { actions: 'connection_logAppend' },
  SESSIONS_UPDATED: { actions: 'connection_sessionsUpdated' },
  SNAPSHOTS_UPDATED: { actions: 'connection_snapshotsUpdated' },
  RESTORE_SESSION: {
    guard: notReadOnly,
    actions: 'connection_restoreSession',
  },
  SESSION_MENU_OPENED: {
    actions: 'connection_sessionMenuOpened',
  },
  GIT_REPOSITORIES_UPDATED: { actions: 'connection_gitRepositoriesUpdated' },
  SERVERS_UPDATED: { actions: 'connection_serversUpdated' },
  TMUX_CLIPBOARD: { actions: 'connection_tmuxClipboard' },
  SET_CHAR_SIZE: { actions: 'connection_setCharSize' },
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
    guard: notReadOnly,
    actions: 'connection_createTab',
  },
  CONNECT_SERVER: {
    actions: 'connection_connectServer',
  },
  RECONNECT_NOW: {
    actions: 'connection_reconnectNow',
  },
  DETACH_CLIENT: {
    guard: notReadOnly,
    actions: 'connection_detachClient',
  },
  SWITCH_SESSION: { actions: 'connection_switchSession' },
} as const;

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
    enqueue(() => writeClipboard(event.text, event.paneId));
    enqueue.raise({
      type: 'SHOW_STATUS_MESSAGE' as const,
      text: clipboardWriteMessage(event.text, event.paneId),
    });
  }),

  connection_setCharSize: assignCtx(({ event }) =>
    event.type === 'SET_CHAR_SIZE'
      ? {
          charWidth: event.charWidth,
          charHeight: event.charHeight,
          cellGap: event.cellGap,
          gridFontSize: event.gridFontSize ?? null,
        }
      : {},
  ),

  connection_setPhoneLayout: assignCtx(({ event }) =>
    event.type === 'SET_PHONE_LAYOUT' ? { phoneLayout: event.phone } : {},
  ),

  connection_setTargetSize: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_TARGET_SIZE') return;
    const cols = context.phoneLayout ? PHONE_COLS : event.cols;
    const rows = context.phoneLayout ? PHONE_ROWS : event.rows;
    enqueue(
      assign({
        targetCols: cols,
        targetRows: rows,
      }),
    );
    enqueue.raise({ type: 'SYNC_DOCK_ROWS' as const });

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
      !context.readOnly &&
      context.connected &&
      grid.cols > 0 &&
      (cols !== grid.cols || rows !== grid.rows);
    if (shouldResize) {
      enqueue(
        sendTo('tmux', {
          type: 'INVOKE' as const,
          cmd: 'set_client_size',
          args: { cols, rows },
        }),
      );
    }
  }),

  connection_setContainerSize: assignCtx(({ event }) =>
    event.type === 'SET_CONTAINER_SIZE'
      ? { containerWidth: event.width, containerHeight: event.height }
      : {},
  ),

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

  connection_appFocus: act(({ enqueue }) => {
    enqueue(assign({ appFocused: true }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_ENABLED' as const, enabled: true }));
  }),

  connection_appBlur: act(({ enqueue }) => {
    enqueue(assign({ appFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_ENABLED' as const, enabled: false }));
  }),

  connection_connectionInfo: assignCtx(({ event }) =>
    event.type === 'CONNECTION_INFO'
      ? { defaultShell: event.defaultShell, readOnly: event.readOnly }
      : {},
  ),

  connection_createTab: act(({ enqueue }) => {
    enqueue.raise({ type: 'DISPATCH_OP' as const, op: TmuxOp.NewWindow() });
  }),

  connection_connectServer: act(({ event, enqueue }) => {
    if (event.type !== 'CONNECT_SERVER') return;
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

  connection_switchSession: act(({ event, enqueue }) => {
    if (event.type !== 'SWITCH_SESSION') return;
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

  connection_onConnected: act(({ context, enqueue }) => {
    enqueue(assign({ connected: true, error: null }));
    enqueue(sendTo('size', { type: 'CONNECTED' as const }));
    enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
    enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));

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
  }),

  connection_onReconnected: act(({ enqueue }) => {
    enqueue(assign({ connected: true, error: null }));
    enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
    enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));
  }),

  connection_keybindingsReceived: act(({ event, enqueue }) => {
    if (event.type !== 'KEYBINDINGS_RECEIVED') return;
    enqueue(assign({ keybindings: event.keybindings }));
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_KEYBINDINGS' as const,
        keybindings: event.keybindings,
      }),
    );
  }),
};
