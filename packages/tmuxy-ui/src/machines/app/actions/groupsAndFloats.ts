import { sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import { visibleFloats } from '../../selectors/panesAndSidebars';

export const groupsAndFloatsActions = {
  groupsAndFloats_openConnectFloat: act(({ context, enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.OpenFloat({
          command: ['tmuxy', 'session', 'connect'],
          splitFrom: context.activePaneId,
        }),
      }),
    );
  }),

  /**
   * Close a float: kill its pane through the store, which takes it off screen
   * at once (the model update then drops the float and hands the keyboard on).
   */
  groupsAndFloats_closeFloat: act(({ event, enqueue }) => {
    if (event.type !== 'CLOSE_FLOAT') return;
    enqueue.raise({ type: 'DISPATCH_OP' as const, op: TmuxOp.KillPane({ paneId: event.paneId }) });
  }),
};

/**
 * The floats against a model update (`prev` → the `next` floats): one that
 * comes into view takes the keyboard (and its entrance is not animated), one
 * that holds it and goes hands it on.
 */
export function reconcileFloats(
  prev: Ctx,
  next: Pick<Ctx, 'floatPanes' | 'windows' | 'activeWindowId'>,
  enqueue: Enqueue,
) {
  const shown = (c: typeof next) =>
    visibleFloats(c.floatPanes, c.windows, c.activeWindowId).map((f) => f.paneId);
  const before = shown(prev);
  const added = shown(next).some((id) => !before.includes(id));
  if (added) enqueue.raise({ type: 'SUPPRESS_ANIMATIONS' as const });
  enqueue.raise({ type: 'SYNC_FLOAT_FOCUS' as const, claim: added });
}
