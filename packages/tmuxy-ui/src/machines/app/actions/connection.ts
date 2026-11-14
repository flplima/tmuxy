import { assign, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from '../actionTypes';
import { takeKeyboard } from '../helpers';
import { PANES_OWN_KEYBOARD } from '../../selectors/keyboard';
import {
  writeClipboard,
  clipboardBlockedMessage,
  clipboardWriteMessage,
} from '../../../infra/clipboard';
import { TmuxOp } from '../../../domain/commands';
import { invokeEvent } from '../../actors/tmuxActor';
import { memorableSessionName } from '../../../domain/sessionNames';
import { isTauri } from '../../../infra/platform';
import type { PanePorts } from '../../../domain/servers';

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

/** The most keys and commands held while the page first connects. */
export const MAX_HELD_COMMANDS = 512;

/** A held key older than this when the connection lands is dropped, not sent. */
export const HELD_MAX_AGE_MS = 5000;

const keysWord = (n: number) => (n === 1 ? '1 key' : `${n} keys`);
const was = (n: number) => (n === 1 ? 'was' : 'were');

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

  // The poll answers every few seconds and almost always the same: the old
  // list is kept then, so nothing that reads it draws again.
  connection_panePortsUpdated: assignCtx(({ context, event }) =>
    event.type === 'PANE_PORTS_UPDATED' && !samePanePorts(context.panePorts, event.panePorts)
      ? { panePorts: event.panePorts }
      : {},
  ),

  connection_treeRowTemplateUpdated: assignCtx(({ event }) =>
    event.type === 'TREE_ROW_TEMPLATE_UPDATED' ? { treeRowTemplate: event.treeRowTemplate } : {},
  ),

  connection_serversUpdated: assignCtx(({ event }) =>
    event.type === 'SERVERS_UPDATED'
      ? { servers: event.servers, currentServerId: event.currentServerId }
      : {},
  ),

  // Announced once the browser has answered, and as what happened: a write no
  // key or click came just before is one Firefox and Safari turn down.
  connection_tmuxClipboard: act(({ event, enqueue, self }) => {
    if (event.type !== 'TMUX_CLIPBOARD') return;
    const { text, paneId } = event;
    enqueue(() => {
      void writeClipboard(text, paneId).then((copied) =>
        self.send({
          type: 'SHOW_STATUS_MESSAGE',
          text: (copied ? clipboardWriteMessage : clipboardBlockedMessage)(text, paneId),
        }),
      );
    });
  }),

  connection_appFocus: assignCtx({ appFocused: true }),

  connection_appBlur: assignCtx({ appFocused: false }),

  connection_connectionInfo: act(({ event, enqueue }) => {
    if (event.type !== 'CONNECTION_INFO') return;
    enqueue(assign({ serverHostname: event.hostname }));
    enqueue(sendTo('tmuxStore', { type: 'SET_DEFAULT_SHELL' as const, shell: event.defaultShell }));
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
      sendTo(
        'tmux',
        invokeEvent({
          cmd: 'connect_server',
          args: { id: event.serverId, session: event.session ?? null },
        }),
      ),
    );
  }),

  connection_reconnectNow: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'RECONNECT_NOW' as const }));
  }),

  connection_detachClient: act(({ enqueue }) => {
    enqueue(sendTo('tmux', invokeEvent({ cmd: 'detach_client', args: {} })));
  }),

  // Create a session AND switch to it, so the action has a visible effect. On
  // web the switch reconnects with ?session=<name>, and the server's attach
  // creates the session if the create has not landed yet; on Tauri the create
  // must precede switch-client, which the two raised events keep in order. The
  // name is the one the user typed (the palette offers it only when no session
  // has it), else one no session in the last poll has, nor the attached one,
  // nor a snapshot the switcher offers to restore (a session made under a
  // snapshot's name would be saved over it).
  connection_newSession: act(({ context, event, enqueue }) => {
    const typed = event.type === 'NEW_SESSION' ? event.name : undefined;
    const sessionName =
      typed ??
      memorableSessionName([
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

  // A switch that opened a new stream fetches the state, as a reconnect does:
  // a monitor the server just attached broadcasts it, but one that was still
  // up (the session was left less than its grace period ago, or another client
  // watches it) has nothing new to say, and the panes cleared for the switch
  // stayed cleared. The desktop's switch-client is not waited on, so a fetch
  // there could answer with the session it was leaving.
  connection_sessionSwitched: act(({ context, enqueue }) => {
    fetchStateAtViewport(context, enqueue);
  }),

  // The size actor answers RESEND_SIZE by sending the target size again, and
  // that SET_TARGET_SIZE is what fetches the initial state (once, at the size
  // the client measured).
  connection_onConnected: act(({ context, enqueue }) => {
    enqueue(
      assign({ connected: true, error: null, fatalError: null, heldCommands: [], heldOverflow: 0 }),
    );
    enqueue(sendTo('size', { type: 'RESEND_SIZE' as const }));
    fetchThemes(enqueue);
    // Typed while the page attached: sent now, in the order typed, ahead of
    // anything typed after (a raised event goes before the next one in). All
    // of it or none: if the oldest waited longer than HELD_MAX_AGE_MS, or the
    // bound pushed some out, the rest is a line's tail, and an Enter in it
    // would run that tail as a command.
    const held = context.heldCommands;
    const stale = held.length > 0 && Date.now() - held[0].at > HELD_MAX_AGE_MS;
    if (stale || context.heldOverflow > 0) {
      const dropped = held.length + context.heldOverflow;
      enqueue.raise({
        type: 'NOTIFY' as const,
        text: `${keysWord(dropped)} typed while connecting took too long to send and ${was(dropped)} dropped`,
      });
      return;
    }
    for (const command of held) enqueue.raise(command.command);
  }),

  /**
   * A key or command before the first connection is held, not dropped: the
   * page takes keys from its first frame, the session arrives a moment later.
   * Past {@link MAX_HELD_COMMANDS} the oldest go and are counted (and then
   * nothing is sent: `connection_onConnected`): a page that never connects
   * does not grow without end.
   */
  connection_holdCommand: act(({ context, event, enqueue }) => {
    if (event.type !== 'DISPATCH_OP' && event.type !== 'SEND_TMUX_COMMAND') return;
    const all = [...context.heldCommands, { command: event, at: Date.now() }];
    const over = Math.max(0, all.length - MAX_HELD_COMMANDS);
    enqueue(assign({ heldCommands: all.slice(over), heldOverflow: context.heldOverflow + over }));
  }),

  /**
   * The first connection failed: what was typed meanwhile is dropped, never
   * sent when a later one succeeds (an Enter in it could run a command the
   * user has given up on). A notice says how much.
   */
  connection_dropHeld: act(({ context, enqueue }) => {
    const dropped = context.heldCommands.length + context.heldOverflow;
    if (dropped === 0) return;
    enqueue(assign({ heldCommands: [], heldOverflow: 0 }));
    enqueue.raise({
      type: 'NOTIFY' as const,
      text: `${keysWord(dropped)} typed before the connection failed ${was(dropped)} not sent`,
    });
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

function samePanePorts(a: readonly PanePorts[], b: readonly PanePorts[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.paneId === b[i].paneId &&
        entry.ports.length === b[i].ports.length &&
        entry.ports.every((port, j) => port === b[i].ports[j]),
    )
  );
}
