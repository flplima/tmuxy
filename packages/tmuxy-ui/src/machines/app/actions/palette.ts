import { sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';

/**
 * How long a place in another session is waited for after the switch. Past
 * it the tab or pane is taken to be gone, and the session is left as tmux
 * showed it.
 */
const GO_TO_PATIENCE_MS = 10_000;

export const paletteActions = {
  palette_toggle: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_PALETTE') return;
    if (context.palette === event.mode) {
      enqueue.assign({ palette: null });
      return;
    }
    enqueue.assign({ palette: event.mode });
    // The other sessions' tabs and panes are listed from the poll, which
    // runs only while a tree is on screen: ask for them now.
    enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
  }),

  palette_close: assignCtx({ palette: null }),

  /**
   * In this session, the place is picked the way a click picks it. In another
   * one, the session is switched and the place is remembered until its state
   * arrives (`palette_land`): its panes are not this client's to select yet.
   */
  palette_goTo: act(({ context, event, enqueue }) => {
    if (event.type !== 'GO_TO') return;
    const { sessionName, windowId, paneId } = event;
    if (sessionName === context.sessionName) {
      enqueue.assign({ pendingGoTo: null });
      enqueue.raise(paneId ? { type: 'SELECT_PANE', paneId } : { type: 'SELECT_TAB', windowId });
      return;
    }
    enqueue.assign({
      pendingGoTo: { sessionName, windowId, paneId: paneId ?? null, at: Date.now() },
    });
    enqueue.raise({ type: 'SWITCH_SESSION', sessionName });
  }),

  /** A switch to any other session than the one a place is waited for in: the wait is over. */
  palette_leave: assignCtx(({ context, event }) =>
    event.type === 'SWITCH_SESSION' && context.pendingGoTo?.sessionName !== event.sessionName
      ? { pendingGoTo: null }
      : {},
  ),

  /**
   * After a model update: pick the remembered place once its session's state
   * names it. A frame of the session just left may still arrive first; it
   * holds none of the other session's panes, and is waited through.
   */
  palette_land: act(({ context, enqueue }) => {
    const goTo = context.pendingGoTo;
    if (!goTo) return;
    if (Date.now() - goTo.at > GO_TO_PATIENCE_MS) {
      enqueue.assign({ pendingGoTo: null });
      return;
    }
    if (goTo.sessionName !== context.sessionName) return;
    const { paneId, windowId } = goTo;
    if (paneId) {
      if (!context.panes.some((pane) => pane.tmuxId === paneId)) return;
      enqueue.assign({ pendingGoTo: null });
      enqueue.raise({ type: 'SELECT_PANE', paneId });
    } else {
      if (!context.windows.some((window) => window.id === windowId)) return;
      enqueue.assign({ pendingGoTo: null });
      enqueue.raise({ type: 'SELECT_TAB', windowId });
    }
  }),
};
