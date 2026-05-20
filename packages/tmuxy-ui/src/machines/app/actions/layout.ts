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
 *   - COPY_SELECTION (orchestrates clipboard + SIGINT decision)
 *   - CREATE_TAB (raises SEND_TMUX_COMMAND — needs to live where SEND_TMUX is)
 */

import { assign, enqueueActions, sendTo } from 'xstate';
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

      enqueue(
        assign({
          activeWindowId: event.windowId,
          activePaneId: targetPaneId,
          lastActivePaneByWindow,
          pendingSelectTabAt: Date.now(),
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
