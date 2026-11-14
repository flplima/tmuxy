/**
 * The activity inbox: every pane on the server that declared a state, across
 * sessions, most urgent first, and the way to it. See docs/ACTIVITY.md.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { mostUrgent, type ActivityTarget } from '../../../domain/activity';
import { TmuxOp } from '../../../domain/commands';

/**
 * Go to a pane. In the session in view it is a tab and a pane picked, as a
 * click would. In another session tmux is first told which window and pane
 * that session has in front, and then this client moves there: it arrives
 * on the pane, not on whatever the session showed last.
 */
function goTo(enqueue: Enqueue, context: Ctx, target: ActivityTarget): void {
  if (target.session !== context.sessionName) {
    enqueue(sendTo('tmux', { type: 'GO_TO_PANE' as const, ...target }));
    return;
  }
  enqueue.raise({
    type: 'DISPATCH_OP',
    op: TmuxOp.SelectWindow({ target: target.windowId }),
  });
  enqueue.raise({ type: 'DISPATCH_OP', op: TmuxOp.SelectPane({ paneId: target.paneId }) });
}

function fetch(enqueue: Enqueue, go?: 'most-urgent'): void {
  enqueue(sendTo('tmux', { type: 'FETCH_ACTIVITY' as const, ...(go ? { go } : {}) }));
}

export const activityActions = {
  /** Opening reads the panes at once; what an earlier look left is shown meanwhile. */
  activity_toggle: act(({ context, enqueue }) => {
    enqueue(assign({ activityOpen: !context.activityOpen }));
    if (!context.activityOpen) fetch(enqueue);
  }),

  activity_refresh: act(({ context, enqueue }) => {
    if (context.activityOpen) fetch(enqueue);
  }),

  activity_loaded: act(({ event, context, enqueue }) => {
    if (event.type !== 'ACTIVITY_LOADED') return;
    enqueue(assign({ activityRows: event.rows }));
    if (event.go !== 'most-urgent') return;
    const target = mostUrgent(event.rows, context.activePaneId);
    if (target) goTo(enqueue, context, target);
    else enqueue.raise({ type: 'NOTIFY', kind: 'info', text: 'No pane needs you' });
  }),

  activity_go: act(({ event, context, enqueue }) => {
    if (event.type !== 'ACTIVITY_GO') return;
    enqueue(assign({ activityOpen: false }));
    goTo(enqueue, context, event.row);
  }),

  /** The panes are read first: what the inbox last showed may be minutes old. */
  activity_goMostUrgent: act(({ enqueue }) => {
    fetch(enqueue, 'most-urgent');
  }),
};
