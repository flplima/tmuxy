/**
 * Action implementations for the groupsAndFloats state slice.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId.
 *
 * SELECT_PANE_GROUP_TAB lives inline in appMachine.ts: it touches layout
 * fields (panes, activePaneId) during optimistic group swaps.
 */

import { assign, sendTo } from 'xstate';
import { act } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import type { TmuxWindow } from '../../../domain/client';
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
          run: 'tmuxy connect',
          index: freeWindowIndex(context.windows),
          splitFrom: context.activePaneId,
        }),
      }),
    );
  }),

  /**
   * Hand the keyboard to the float of the tab now in front of the user, or back
   * to that tab's panes when it has none.
   */
  groupsAndFloats_syncFloatFocus: act(({ context, enqueue }) => {
    const floats = visibleFloats(context.floatPanes, context.windows, context.activeWindowId);
    const next = floats.length > 0 ? floats[floats.length - 1].paneId : null;
    if (next === context.focusedFloatPaneId) return;
    enqueue(assign({ focusedFloatPaneId: next }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: next }));
  }),

  groupsAndFloats_closeFloat: act(({ event, context, enqueue }) => {
    if (event.type !== 'CLOSE_FLOAT') return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.KillPane({ paneId: event.paneId }),
      }),
    );
    const { [event.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    if (context.focusedFloatPaneId === event.paneId) {
      const remaining = visibleFloats(remainingFloats, context.windows, context.activeWindowId);
      const nextFocused = remaining.length > 0 ? remaining[remaining.length - 1].paneId : null;
      enqueue(assign({ focusedFloatPaneId: nextFocused }));
      enqueue(
        sendTo('keyboard', {
          type: 'UPDATE_FOCUSED_FLOAT' as const,
          paneId: nextFocused,
        }),
      );
    }
  }),

  groupsAndFloats_closeTopFloat: act(({ context, enqueue }) => {
    const floats = visibleFloats(context.floatPanes, context.windows, context.activeWindowId);
    if (floats.length === 0) return;
    const topFloat = floats[floats.length - 1];
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.KillPane({ paneId: topFloat.paneId }),
      }),
    );
    const { [topFloat.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    const remaining = visibleFloats(remainingFloats, context.windows, context.activeWindowId);
    const nextFocused = remaining.length > 0 ? remaining[remaining.length - 1].paneId : null;
    enqueue(assign({ focusedFloatPaneId: nextFocused }));
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_FOCUSED_FLOAT' as const,
        paneId: nextFocused,
      }),
    );
  }),
};
