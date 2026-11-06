/**
 * connection state — the stream to the server, the session it carries, and
 * what the server says about itself (bindings, sessions, servers). Every
 * event is spread into the machine root: bindings pushed during an outage are
 * kept, not dropped.
 */

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
  KEYBINDINGS_RECEIVED: { actions: 'connection_keybindingsReceived' },
} as const;
