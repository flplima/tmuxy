import { sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';

/**
 * How long the first frame of the session switched to is waited for. Past it
 * the place is forgotten, and the session is left as tmux shows it.
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
   * After a model update: pick the remembered place on the first frame of
   * its session, and forget it either way. A place that frame does not name
   * is gone, and waiting on would move the focus under a user who has since
   * picked something else. A frame of the session just left may still arrive
   * first; it is not the session's, and is waited through.
   */
  palette_land: act(({ context, enqueue }) => {
    const goTo = context.pendingGoTo;
    if (!goTo) return;
    const late = Date.now() - goTo.at > GO_TO_PATIENCE_MS;
    if (!late && (goTo.sessionName !== context.sessionName || context.panes.length === 0)) return;
    enqueue.assign({ pendingGoTo: null });
    if (late) return;
    const { paneId, windowId } = goTo;
    if (paneId && context.panes.some((pane) => pane.tmuxId === paneId)) {
      enqueue.raise({ type: 'SELECT_PANE', paneId });
    } else if (!paneId && context.windows.some((window) => window.id === windowId)) {
      enqueue.raise({ type: 'SELECT_TAB', windowId });
    }
  }),
};
