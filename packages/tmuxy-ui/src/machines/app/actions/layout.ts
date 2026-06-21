/**
 * Action implementations for the layout parallel state.
 *
 * Owns context fields: panes, windows, activeWindowId, activePaneId,
 * paneActivationOrder, lastActivePaneByWindow,
 * paneKeyOverrides, pendingSelectTabAt, pendingUpdate, lastLayoutCommandTime,
 * drag, resize, resizeActive, suppressLayoutTransition.
 *
 * MIGRATED HERE (the cleanly-layout-owned events):
 *   SEND_KEYS, CLOSE_PANE, ZOOM_PANE, WRITE_TO_PANE, SELECT_TAB,
 *   KEY_PRESS, RESIZE_STATE_UPDATE, RESIZE_COMPLETED, RESIZE_ERROR,
 *   DRAG_STATE_UPDATE, DRAG_COMPLETED, DRAG_ERROR, ANIMATION_LEAVE_COMPLETE,
 *   ANIMATION_DRAG_COMPLETE, CLEAR_LAYOUT_TRANSITION_SUPPRESSION.
 *
 * STILL IN appMachine.ts (cross-cutting orchestrators that touch multiple
 * states' fields and don't extract cleanly without restructuring):
 *   - SEND_TMUX_COMMAND (optimistic intercept, also writes commandMode/statusMessage)
 *   - TMUX_STATE_UPDATE (the ~600-line reconciliation — sliced via helpers/tmuxStateSlices.ts)
 *   - FOCUS_PANE (writes focusedFloatPaneId which is groupsAndFloats-owned)
 *   - SELECT_PANE_GROUP_TAB (writes both panes and groupSwitchDimOverrides)
 *   - DRAG_START (large assign that snapshots pane positions)
 *   - CREATE_TAB (raises SEND_TMUX_COMMAND — needs to live where SEND_TMUX is)
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/**
 * How long an optimistic SELECT_TAB pin holds `activeWindowId` over stale
 * server snapshots before the server's value wins. Shared between the
 * snapshot-driven grace in TMUX_MODEL_UPDATE and the timer-driven
 * RECONCILE_SELECT_TAB safety net that fires when no snapshot follows.
 */
export const SELECT_TAB_GRACE_MS = 200;

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
    ({ event, enqueue }) => {
      if (event.type !== 'CLOSE_PANE') return;
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
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `select-pane -t ${event.paneId}`,
        }),
      );
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: 'resize-pane -Z',
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
      const remembered = context.lastActivePaneByWindow[event.windowId];
      const rememberedExists = remembered && targetPanes.some((p) => p.tmuxId === remembered);
      const targetPaneId =
        (rememberedExists ? remembered : null) ??
        targetPanes.find((p) => p.active)?.tmuxId ??
        targetPanes[0]?.tmuxId ??
        null;

      const flippedAt = Date.now();
      enqueue(
        assign({
          activeWindowId: event.windowId,
          activePaneId: targetPaneId,
          lastActivePaneByWindow,
          pendingSelectTabAt: flippedAt,
        }),
      );

      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
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

      // Safety net: the optimistic pin above is only ever resolved by a future
      // TMUX_MODEL_UPDATE snapshot. On an idle terminal no snapshot follows a
      // switch, so a wrong prediction (tmux didn't actually land on this window)
      // would stick forever — the UI renders the wrong tab's panes indefinitely.
      // Fire a self-event once the grace period elapses to force reconciliation
      // against server truth even in the no-snapshot case.
      enqueue(({ self }) => {
        setTimeout(() => {
          self.send({ type: 'RECONCILE_SELECT_TAB', scheduledAt: flippedAt });
        }, SELECT_TAB_GRACE_MS + 50);
      });
    },
  ),

  /**
   * Timer-driven resolution of a SELECT_TAB optimistic pin (see layout_selectTab).
   * Runs only when the pin is still outstanding and hasn't been superseded by a
   * newer switch. Reconciles `activeWindowId` to the server's actual active
   * window — derived from the `active` flag on `context.windows`, which is never
   * pinned and always reflects the latest server snapshot. In the no-snapshot
   * case this is exactly where tmux still is; a confirming/correcting snapshot
   * would already have cleared `pendingSelectTabAt` before this fires.
   */
  layout_reconcileSelectTab: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, context, enqueue }) => {
    if (event.type !== 'RECONCILE_SELECT_TAB') return;
    // Already resolved by a snapshot, or superseded by a newer SELECT_TAB.
    if (context.pendingSelectTabAt === null) return;
    if (context.pendingSelectTabAt !== event.scheduledAt) return;

    const serverActive = context.windows.find((w) => w.windowType === 'tab' && w.active);

    // No active tab to reconcile to — just drop the pin so the next snapshot wins.
    if (!serverActive || serverActive.id === context.activeWindowId) {
      enqueue(assign({ pendingSelectTabAt: null }));
      return;
    }

    // Optimistic prediction diverged from server truth. Snap back to the real
    // active window and its remembered (or active) pane.
    const targetPanes = context.panes.filter((p) => p.windowId === serverActive.id);
    const remembered = context.lastActivePaneByWindow[serverActive.id];
    const rememberedExists = remembered && targetPanes.some((p) => p.tmuxId === remembered);
    const targetPaneId =
      (rememberedExists ? remembered : null) ??
      targetPanes.find((p) => p.active)?.tmuxId ??
      targetPanes[0]?.tmuxId ??
      null;

    enqueue(
      assign({
        activeWindowId: serverActive.id,
        activePaneId: targetPaneId,
        pendingSelectTabAt: null,
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
  }),

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

  layout_applyResizeState: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'RESIZE_STATE_UPDATE') return {};
    return { resize: event.resize, resizeActive: event.resize !== null };
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
    // Keep resize state as optimistic preview until next TMUX_STATE_UPDATE
    // arrives with server-confirmed pane sizes. Timeout fallback: clear
    // after 2s in case the server update is delayed.
    enqueue(({ self }) => {
      setTimeout(() => {
        const snap = self.getSnapshot();
        if (snap.context.resize) {
          self.send({ type: 'RESIZE_STATE_UPDATE', resize: null });
        }
      }, 2000);
    });
  }),

  layout_resizeError: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'RESIZE_ERROR') return {};
    // cross-cutting: `error` is parent-owned, but layout exposes resize
    // errors through the same surface so the existing error UI keeps working.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { error: event.error, resize: null, resizeActive: false } as any;
  }),

  layout_dragStateUpdate: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'DRAG_STATE_UPDATE') return {};
    return { drag: event.drag };
  }),

  layout_dragError: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'DRAG_ERROR') return {};
    // cross-cutting: `error` is parent-owned (see layout_resizeError).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { error: event.error, drag: null } as any;
  }),

  layout_clearLayoutTransitionSuppression: assign<Ctx, Evt, undefined, Evt, never>({
    suppressLayoutTransition: false,
  }),
};
