/**
 * Action implementations for the groupsAndFloats state slice.
 */

import { sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import type { TmuxWindow } from '../../../domain/client';
import { topVisibleFloat } from '../../selectors/keyboard';
import { visibleFloats } from '../../selectors/panesAndSidebars';

/**
 * The lowest window index the session isn't using, scanning up from its lowest
 * one (so a `base-index 1` session never gets a stray window 0) — where a new
 * float is created (see `OpenFloat`).
 *
 * `break-pane` picks this index on its own, but it doesn't tell us which window
 * it made — and `set-option -w` with no target resolves against the session's
 * *current* window, which `break-pane -d` deliberately leaves unchanged. Naming
 * the index up front is what lets the tag land on the NEW window inside one
 * atomic command list (tagging late would let the monitor see the `%window-add`
 * before the marker exists, and render a chrome window as a tab).
 */
export function freeWindowIndex(windows: TmuxWindow[]): number {
  const used = new Set(windows.map((w) => w.index));
  let index = windows.length > 0 ? Math.min(...used) : 0;
  while (used.has(index)) index++;
  return index;
}

export const groupsAndFloatsActions = {
  groupsAndFloats_openConnectFloat: act(({ context, enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.OpenFloat({
          name: 'connect',
          run: 'tmuxy session connect',
          index: freeWindowIndex(context.windows),
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

  groupsAndFloats_closeTopFloat: act(({ context, enqueue }) => {
    const top = topVisibleFloat(context.floatPanes, context.windows, context.activeWindowId);
    if (top) enqueue.raise({ type: 'CLOSE_FLOAT' as const, paneId: top });
  }),
};

/**
 * The floats against a model update (`prev` → the `next` floats): one that
 * comes into view takes the keyboard (and its entrance is not animated), one
 * that holds it and goes hands it on. A float closing may be the session
 * switcher's, which leaves its choice in tmux for this client to act on.
 */
export function reconcileFloats(
  prev: Ctx,
  next: Pick<Ctx, 'floatPanes' | 'windows' | 'activeWindowId'>,
  enqueue: Enqueue,
) {
  if (Object.keys(next.floatPanes).length < Object.keys(prev.floatPanes).length) {
    enqueue(sendTo('tmux', { type: 'CHECK_SESSION_SWITCH' as const }));
  }
  const shown = (c: typeof next) =>
    visibleFloats(c.floatPanes, c.windows, c.activeWindowId).map((f) => f.paneId);
  const before = shown(prev);
  const added = shown(next).some((id) => !before.includes(id));
  if (added) enqueue.raise({ type: 'SUPPRESS_ANIMATIONS' as const });
  enqueue.raise({ type: 'SYNC_FLOAT_FOCUS' as const, claim: added });
}
