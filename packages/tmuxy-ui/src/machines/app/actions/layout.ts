/**
 * Action implementations for the layout state slice.
 *
 * Owns context fields: panes, windows, activeWindowId, activePaneId,
 * paneActivationOrder, lastActivePaneByWindow,
 * paneKeyOverrides, lastLayoutCommandTime,
 * drag, resize, resizeActive, suppressLayoutTransition.
 *
 * Handled here:
 *   SEND_KEYS, CLOSE_PANE, ZOOM_PANE, WRITE_TO_PANE, SELECT_TAB,
 *   KEY_PRESS, RESIZE_STATE_UPDATE, RESIZE_COMPLETED,
 *   DRAG_STATE_UPDATE.
 *
 * In the app machine's own orchestration (cross-cutting handlers that hand
 * work to several slices):
 *   - SEND_TMUX_COMMAND / DISPATCH_OP (the one command routing step, in
 *     ../dispatch.ts)
 *   - TMUX_STATE_UPDATE (one-liner relay to tmuxStore for reconcile; the heavy
 *     downstream work runs in the TMUX_MODEL_UPDATE handler)
 *   - FOCUS_PANE (writes focusedFloatPaneId which is groupsAndFloats-owned)
 *   - SELECT_PANE_GROUP_TAB (dispatches a GroupSwitch op to the store)
 *   - DRAG_START (large assign that snapshots pane positions)
 *   - CREATE_TAB (raises a NewWindow DISPATCH_OP)
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import type { PaneId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';

// Fallback for clearing the optimistic resize preview if the server-confirmed
// TMUX_STATE_UPDATE never arrives. Scheduled as a delayed self-event by id and
// cancelled when a fresh preview supersedes it (see layout_applyResizeState).
const RESIZE_PREVIEW_CLEAR_ID = 'resizePreviewClear';
const RESIZE_PREVIEW_FALLBACK_MS = 2000;

export const layoutActions = {
  layout_sendKeysToTmux: act(({ event, enqueue }) => {
    if (event.type !== 'SEND_KEYS') return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SendKeys({ target: event.paneId, keys: event.keys }),
      }),
    );
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
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.GroupClose({ paneId: event.paneId }),
      }),
    );
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
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SendText({ target: event.paneId, text: event.data }),
      }),
    );
  }),

  layout_selectTab: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_TAB') return;
    if (context.activeWindowId === event.windowId) return;

    const lastActivePaneByWindow = { ...context.lastActivePaneByWindow };
    if (context.activeWindowId && context.activePaneId) {
      lastActivePaneByWindow[context.activeWindowId] = context.activePaneId;
    }

    const targetPanes = context.panes.filter((p) => p.windowId === event.windowId);
    const inTarget = (id: PaneId | null | undefined) =>
      id && targetPanes.some((p) => p.tmuxId === id) ? id : null;
    // Where the switch lands, best knowledge first: the pane this client
    // last left the tab on; the tab's own active pane as tmux reports it
    // (`pane.active` is session-wide, so a background tab's panes never
    // carry it — without the window's own field the switch fell on the
    // first pane for a beat, then jumped); the flagged pane; the first.
    const targetPaneId =
      inTarget(context.lastActivePaneByWindow[event.windowId]) ??
      inTarget(context.windows.find((w) => w.id === event.windowId)?.activePaneId) ??
      targetPanes.find((p) => p.active)?.tmuxId ??
      targetPanes[0]?.tmuxId ??
      null;

    enqueue(
      assign({
        activeWindowId: event.windowId,
        activePaneId: targetPaneId,
        // Flip the per-window active flags too — the tab strip renders
        // aria-selected from windows[].active, and without this the
        // highlight waits for the server round-trip even though the pane
        // grid flipped optimistically.
        windows: context.windows.map((w) => ({ ...w, active: w.id === event.windowId })),
        lastActivePaneByWindow,
      }),
    );

    // Through the STORE: the SelectWindow op's patch + confirm-linger hold
    // the optimistic tab selection over stale snapshots for seconds (the
    // 200ms machine grace alone cannot cover a slow confirm — the tab strip
    // visibly flapped on the v86 transport).
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SelectWindow({ target: event.windowId }),
      }),
    );

    if (targetPaneId !== context.activePaneId) {
      enqueue(
        sendTo('keyboard', {
          type: 'UPDATE_ACTIVE_PANE' as const,
          paneId: targetPaneId,
        }),
      );
    }

    // A float belongs to a tab, so the switch moves the keyboard with it: the
    // target tab's topmost float takes it back, and leaving a tab drops the
    // float that had it (the keyboard cannot stay on a surface that is no
    // longer on screen). Raised rather than left to the model update, which
    // cannot see it: this switch is optimistic, so by the time the update
    // lands the new tab is already the active one and its float no longer
    // looks like one that just came into view.
    enqueue.raise({ type: 'SYNC_FLOAT_FOCUS' as const });
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

  layout_dragStateUpdate: assignCtx(({ event }) => {
    if (event.type !== 'DRAG_STATE_UPDATE') return {};
    return { drag: event.drag };
  }),
};
