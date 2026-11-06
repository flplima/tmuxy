/**
 * Action implementations for the layout state slice.
 */
import { assign, raise, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from '../actionTypes';
import { isPlaceholderId, type PaneId, type WindowId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';
import { scrollViewsIn, takeKeyboard } from '../helpers';
import { selectRightSidebarPane } from '../../selectors/panesAndSidebars';
import { PANES_OWN_KEYBOARD } from '../../selectors/keyboard';

// Fallback for clearing the optimistic resize preview if the server-confirmed
// TMUX_STATE_UPDATE never arrives. Scheduled as a delayed self-event by id and
// cancelled when a fresh preview supersedes it (see layout_applyResizeState).
const RESIZE_PREVIEW_CLEAR_ID = 'resizePreviewClear';
const RESIZE_PREVIEW_FALLBACK_MS = 2000;

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
export function selectTab(context: Ctx, enqueue: EnqueueAction, windowId: WindowId) {
  if (context.activeWindowId === windowId || isPlaceholderId(windowId)) return;
  for (const paneId of scrollViewsIn(context, context.activeWindowId)) {
    enqueue(raise({ type: 'EXIT_SCROLL_MODE' as const, paneId }));
  }
  enqueue(
    sendTo('tmuxStore', {
      type: 'DISPATCH_OP' as const,
      op: TmuxOp.SelectWindow({ target: windowId }),
    }),
  );
}

/** The member of a group drawn in a tab (the others are parked in the stash). */
function shownMember(context: Ctx, members: readonly PaneId[]) {
  const tabs = new Set(context.windows.filter((w) => w.windowType === 'tab').map((w) => w.id));
  return (
    context.panes.find((p) => members.includes(p.tmuxId) && p.windowId && tabs.has(p.windowId)) ??
    null
  );
}

/** A group member parked out of view: in a group, and not in the window on screen. */
function isParkedMember(context: Ctx, paneId: PaneId): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return !!pane?.groupId && pane.windowId !== context.activeWindowId;
}

export const layoutActions = {
  /**
   * The user picked a pane — clicked it, its header tab, its tree row, a
   * notification for it. The machine works out how to get there: the dock
   * and a float take the keyboard where they are; a group member out of view
   * is swapped into its group's slot (GroupSwitch; a `select-pane` into the
   * stash would race the swap); a pane in another tab switches to that tab
   * first, since `select-pane` never changes the session's current window.
   */
  layout_selectPane: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_PANE') return;
    const { paneId } = event;
    if (selectRightSidebarPane(context)?.tmuxId === paneId) {
      enqueue.raise({ type: 'FOCUS_SIDEBAR', side: 'right' });
      return;
    }
    if (context.floatPanes[paneId]) {
      takeKeyboard(enqueue, { kind: 'float', paneId });
      return;
    }
    const pane = context.panes.find((p) => p.tmuxId === paneId);
    if (!pane) return;
    takeKeyboard(enqueue, PANES_OWN_KEYBOARD);

    const group = Object.values(context.paneGroups).find((g) => g.paneIds.includes(paneId));
    const shown = group ? shownMember(context, group.paneIds) : null;
    if (group && shown?.tmuxId !== paneId) {
      if (shown && shown.windowId !== context.activeWindowId) {
        selectTab(context, enqueue, shown.windowId);
      }
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_OP' as const,
          op: TmuxOp.GroupSwitch({ clickedPaneId: paneId, visiblePaneId: shown?.tmuxId ?? null }),
        }),
      );
      return;
    }

    const inFront = pane.windowId === context.activeWindowId;
    if (!inFront) selectTab(context, enqueue, pane.windowId);
    if (inFront && paneId === context.activePaneId) return;
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SelectPane({ paneId }),
      }),
    );
  }),

  layout_dragStart: act(({ event, context, enqueue }) => {
    if (event.type !== 'DRAG_START') return;
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    const memberDrag = isParkedMember(context, event.paneId);
    enqueue(
      sendTo('dragLogic', {
        ...event,
        panes: context.activeWindowId
          ? context.panes.filter((p) => p.windowId === context.activeWindowId)
          : context.panes,
        charWidth: context.charWidth,
        charHeight: context.charHeight,
        containerWidth: context.containerWidth,
        paneWindowId: pane?.windowId ?? null,
        panesInWindow: pane ? context.panes.filter((p) => p.windowId === pane.windowId).length : 0,
        groups: context.paneGroups,
        memberDrag,
      }),
    );
  }),

  layout_resizeStart: act(({ event, context, enqueue }) => {
    if (event.type !== 'RESIZE_START') return;
    enqueue(
      sendTo('resizeLogic', {
        ...event,
        panes: context.panes,
        windows: context.windows,
        charWidth: context.charWidth,
        charHeight: context.charHeight,
      }),
    );
  }),

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

  layout_selectTab: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_TAB') return;
    selectTab(context, enqueue, event.windowId);
  }),

  /** A pane dropped on another tab: it moves there (the store predicts the join) and that tab comes to the front. */
  layout_movePaneToTab: act(({ event, context, enqueue }) => {
    if (event.type !== 'MOVE_PANE_TO_TAB') return;
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.JoinPane({ paneId: event.paneId, windowId: event.windowId }),
      }),
    );
    selectTab(context, enqueue, event.windowId);
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

  layout_enableAnimations: assignCtx({ enableAnimations: true }),

  layout_dragStateUpdate: assignCtx(({ event }) => {
    if (event.type !== 'DRAG_STATE_UPDATE') return {};
    return { drag: event.drag };
  }),
};
