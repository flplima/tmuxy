/**
 * Action implementations for the layout state slice.
 */
import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import { isPlaceholderId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';
import { scrollViewsIn } from '../helpers';

// Fallback for clearing the optimistic resize preview if the server-confirmed
// TMUX_STATE_UPDATE never arrives. Scheduled as a delayed self-event by id and
// cancelled when a fresh preview supersedes it (see layout_applyResizeState).
const RESIZE_PREVIEW_CLEAR_ID = 'resizePreviewClear';
const RESIZE_PREVIEW_FALLBACK_MS = 2000;

export const layoutActions = {
  layout_sendKeysToTmux: act(({ event, enqueue }) => {
    if (event.type !== 'SEND_KEYS') return;
    enqueue.raise({
      type: 'DISPATCH_OP' as const,
      op: TmuxOp.SendKeys({ target: event.paneId, keys: event.keys }),
    });
  }),

  layout_closePane: act(({ event, context, enqueue }) => {
    if (event.type !== 'CLOSE_PANE') return;
    // Group members and floats need the group-aware close script (swap-in /
    // window cleanup / option bookkeeping — server-side semantics we can't
    // predict). A plain pane is exactly `kill-pane` (the script's own
    // fallback), so dispatch it through the STORE for the optimistic
    // removal + exit animation on click instead of on the round-trip.
    const inGroup = Object.values(context.paneGroups).some((g) => g.paneIds.includes(event.paneId));
    const isFloat = Boolean(context.floatPanes[event.paneId]);
    if (!inGroup && !isFloat) {
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_OP' as const,
          op: TmuxOp.KillPane({ paneId: event.paneId }),
        }),
      );
      return;
    }
    enqueue.raise({
      type: 'DISPATCH_OP' as const,
      op: TmuxOp.GroupClose({ paneId: event.paneId }),
    });
  }),

  layout_zoomPane: act(({ event, enqueue }) => {
    if (event.type !== 'ZOOM_PANE') return;
    // Through the store: select-pane gets the focus prediction, and the
    // explicitly-targeted zoom gets the ZoomToggle geometry prediction.
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SelectPane({ paneId: event.paneId }),
      }),
    );
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.ZoomToggle({ paneId: event.paneId }),
      }),
    );
  }),

  layout_writeToPane: act(({ event, enqueue }) => {
    if (event.type !== 'WRITE_TO_PANE') return;
    enqueue.raise({
      type: 'DISPATCH_OP' as const,
      op: TmuxOp.SendText({ target: event.paneId, text: event.data }),
    });
  }),

  /**
   * A tab picked in this client. The store predicts the switch (SelectWindow
   * puts the tab and its active pane in front and holds them over stale
   * snapshots until tmux confirms), and the model update carries the rest:
   * the float of the tab now in front takes the keyboard. A placeholder tab
   * is a window tmux has not named yet: nothing to send, and tmux's current
   * window is already the one it stands for (a new window is selected as it
   * is made). The tab left behind keeps no scroll view open (see
   * closeScrollViewsIn).
   */
  layout_selectTab: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_TAB') return;
    if (context.activeWindowId === event.windowId || isPlaceholderId(event.windowId)) return;
    for (const paneId of scrollViewsIn(context, context.activeWindowId)) {
      enqueue.raise({ type: 'EXIT_SCROLL_MODE', paneId });
    }
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SelectWindow({ target: event.windowId }),
      }),
    );
  }),

  layout_forwardKeyToDragResize: act(({ event, enqueue }) => {
    if (event.type !== 'KEY_PRESS') return;
    enqueue(sendTo('dragLogic', event));
    enqueue(sendTo('resizeLogic', event));
  }),

  layout_applyResizeState: act(({ event, enqueue }) => {
    if (event.type !== 'RESIZE_STATE_UPDATE') return;
    enqueue.assign({ resize: event.resize, resizeActive: event.resize !== null });
    // A fresh preview supersedes any pending fallback-clear of the previous
    // one, so it never nulls the newer preview mid-drag.
    if (event.resize !== null) enqueue.cancel(RESIZE_PREVIEW_CLEAR_ID);
  }),

  layout_resizeCompleted: act(({ enqueue }) => {
    enqueue(assign({ resizeActive: false }));
    // Keep resize state as an optimistic preview until the next
    // TMUX_STATE_UPDATE arrives with server-confirmed pane sizes. Fallback: a
    // delayed self-event clears it if that update is delayed. The raise is
    // cancelled/re-scheduled by id, and cancelled when a new preview arrives,
    // so a stale timer never nulls a newer preview.
    enqueue.cancel(RESIZE_PREVIEW_CLEAR_ID);
    enqueue.raise(
      { type: 'RESIZE_STATE_UPDATE', resize: null },
      { delay: RESIZE_PREVIEW_FALLBACK_MS, id: RESIZE_PREVIEW_CLEAR_ID },
    );
  }),

  layout_suppressAnimations: assignCtx({ enableAnimations: false }),

  layout_dragStateUpdate: assignCtx(({ event }) => {
    if (event.type !== 'DRAG_STATE_UPDATE') return {};
    return { drag: event.drag };
  }),
};
