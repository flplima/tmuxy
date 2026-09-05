/**
 * Action implementations for the layout parallel state.
 *
 * Owns context fields: panes, windows, activeWindowId, activePaneId,
 * paneActivationOrder, lastActivePaneByWindow,
 * paneKeyOverrides, lastLayoutCommandTime,
 * drag, resize, resizeActive, suppressLayoutTransition.
 *
 * MIGRATED HERE (the cleanly-layout-owned events):
 *   SEND_KEYS, CLOSE_PANE, ZOOM_PANE, WRITE_TO_PANE, SELECT_TAB,
 *   KEY_PRESS, RESIZE_STATE_UPDATE, RESIZE_COMPLETED,
 *   DRAG_STATE_UPDATE.
 *
 * STILL IN appMachine.ts (cross-cutting orchestrators that touch multiple
 * states' fields and don't extract cleanly without restructuring):
 *   - SEND_TMUX_COMMAND (optimistic intercept, also writes commandMode/statusMessage)
 *   - TMUX_STATE_UPDATE (one-liner relay to tmuxStore for reconcile; the heavy
 *     downstream work runs in the TMUX_MODEL_UPDATE handler)
 *   - FOCUS_PANE (writes focusedFloatPaneId which is groupsAndFloats-owned)
 *   - SELECT_PANE_GROUP_TAB (dispatches a GroupSwitch op to the store)
 *   - DRAG_START (large assign that snapshots pane positions)
 *   - CREATE_TAB (raises SEND_TMUX_COMMAND — needs to live where SEND_TMUX is)
 */

import { assign, enqueueActions, sendTo } from 'xstate';

// Fallback for clearing the optimistic resize preview if the server-confirmed
// TMUX_STATE_UPDATE never arrives. Scheduled as a delayed self-event by id and
// cancelled when a fresh preview supersedes it (see layout_applyResizeState).
const RESIZE_PREVIEW_CLEAR_ID = 'resizePreviewClear';
const RESIZE_PREVIEW_FALLBACK_MS = 2000;
import type { AppMachineContext, AllAppMachineEvents } from '../../types';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const layoutActions = {
  layout_sendKeysToTmux: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'SEND_KEYS') return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: `send-keys -t ${event.paneId} ${event.keys}`,
      }),
    );
  }),

  layout_closePane: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'CLOSE_PANE') return;
      // Group members and floats need the group-aware close script (swap-in /
      // window cleanup / option bookkeeping — server-side semantics we can't
      // predict). A plain pane is exactly `kill-pane` (the script's own
      // fallback), so dispatch it through the STORE for the optimistic
      // removal + exit animation on click instead of on the round-trip.
      const inGroup = Object.values(context.paneGroups).some((g) =>
        g.paneIds.includes(event.paneId),
      );
      const isFloat = Boolean(context.floatPanes[event.paneId]);
      if (!inGroup && !isFloat) {
        enqueue(
          sendTo('tmuxStore', {
            type: 'DISPATCH_COMMAND' as const,
            command: `kill-pane -t ${event.paneId}`,
          }),
        );
        return;
      }
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-close ${event.paneId}"`,
        }),
      );
    },
  ),

  layout_zoomPane: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, enqueue }) => {
      if (event.type !== 'ZOOM_PANE') return;
      // Through the store: select-pane gets the focus prediction, and the
      // explicitly-targeted zoom gets the ZoomToggle geometry prediction.
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_COMMAND' as const,
          command: `select-pane -t ${event.paneId}`,
        }),
      );
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_COMMAND' as const,
          command: `resize-pane -t ${event.paneId} -Z`,
        }),
      );
    },
  ),

  layout_writeToPane: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, enqueue }) => {
      if (event.type !== 'WRITE_TO_PANE') return;
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `send-keys -t ${event.paneId} -l '${event.data.replace(/'/g, "'\\''")}'`,
        }),
      );
    },
  ),

  layout_selectTab: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'SELECT_TAB') return;
      if (context.activeWindowId === event.windowId) return;

      const lastActivePaneByWindow = { ...context.lastActivePaneByWindow };
      if (context.activeWindowId && context.activePaneId) {
        lastActivePaneByWindow[context.activeWindowId] = context.activePaneId;
      }

      const targetPanes = context.panes.filter((p) => p.windowId === event.windowId);
      const inTarget = (id: string | null | undefined) =>
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
          type: 'DISPATCH_COMMAND' as const,
          command: `select-window -t ${event.windowIndex}`,
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
    },
  ),

  layout_forwardKeyToDragResize: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'KEY_PRESS') return;
    enqueue(sendTo('dragLogic', event));
    enqueue(sendTo('resizeLogic', event));
  }),

  layout_applyResizeState: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'RESIZE_STATE_UPDATE') return;
    enqueue.assign({ resize: event.resize, resizeActive: event.resize !== null });
    // A fresh preview supersedes any pending fallback-clear of the previous
    // one, so it never nulls the newer preview mid-drag.
    if (event.resize !== null) enqueue.cancel(RESIZE_PREVIEW_CLEAR_ID);
  }),

  layout_resizeCompleted: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ enqueue }) => {
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

  layout_dragStateUpdate: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'DRAG_STATE_UPDATE') return {};
    return { drag: event.drag };
  }),
};
