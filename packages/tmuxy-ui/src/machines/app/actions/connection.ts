/**
 * Action implementations for the connection state slice: the stream's
 * lifecycle, the session it carries, and what the server reports.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from '../actionTypes';
import { takeKeyboard } from '../helpers';
import { PANES_OWN_KEYBOARD } from '../../selectors/keyboard';
import { writeClipboard, clipboardWriteMessage } from '../../../infra/clipboard';
import { TmuxOp } from '../../../domain/commands';
import { memorableSessionName } from '../../../domain/sessionNames';
import { isTauri } from '../../../infra/platform';

/** What every freshly opened stream asks the server for. */
function fetchThemes(enqueue: EnqueueAction): void {
  enqueue(sendTo('tmux', { type: 'FETCH_THEME_SETTINGS' as const }));
  enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));
}

/**
 * The state at this client's viewport, once it has been measured. (A phone,
 * or a fixed `@tmuxy-size 80x24`, asks for exactly the default size, so the
 * size itself cannot tell whether it was measured.)
 */
function fetchStateAtViewport(context: Ctx, enqueue: EnqueueAction): void {
  if (context.viewportMeasured) {
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
      // cross-cutting: every slice that mirrors the old session's panes starts empty.
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
      }),
    );
    enqueue.raise({ type: 'SUPPRESS_ANIMATIONS' as const });
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
    enqueue(assign({ connected: true, error: null, fatalError: null }));
    enqueue(sendTo('size', { type: 'CONNECTED' as const }));
    fetchThemes(enqueue);
  }),

  // A reconnect fetches the state too: the stream that came back may belong
  // to a restarted server whose monitor another tab already synced, and an
  // idle session then sends nothing on its own — this tab would keep its
  // last frame until a keystroke. The sequencer reopened on the new stream,
  // so the answer is adopted as the starting state.
  connection_onReconnected: act(({ context, enqueue }) => {
    enqueue(assign({ connected: true, error: null, fatalError: null }));
    fetchThemes(enqueue);
    fetchStateAtViewport(context, enqueue);
  }),

  connection_keybindingsReceived: assignCtx(({ event }) =>
    event.type === 'KEYBINDINGS_RECEIVED' ? { keybindings: event.keybindings } : {},
  ),

  connection_fatal: assignCtx(({ event }) =>
    event.type === 'TMUX_FATAL' ? { fatalError: event.message, connected: false } : {},
  ),

  /** The stream is gone (given up, or this client detached): nothing animates over the dead frame. */
  connection_lost: act(({ enqueue }) => {
    enqueue(assign({ connected: false }));
    enqueue.raise({ type: 'SUPPRESS_ANIMATIONS' as const });
  }),

  connection_reconnecting: assignCtx({ connected: false }),

  connection_error: assignCtx(({ event }) =>
    event.type === 'TMUX_ERROR' ? { error: event.error } : {},
  ),
};
