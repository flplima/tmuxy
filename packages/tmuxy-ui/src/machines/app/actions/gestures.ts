/**
 * Action implementations for the gestures parallel state.
 *
 * A gesture is drawn from `context.gesture` while the fingers move, and turned
 * into the thing it stands for when they lift - through the same events a key
 * or a click sends (SELECT_TAB, ZOOM_PANE, TOGGLE_TAB_OVERVIEW,
 * TAB_OVERVIEW_ACTIVATE), so tmux, the optimistic model and the animations see
 * nothing new.
 *
 * A committed slide switches tabs AT ONCE, in the step that releases it: the
 * keyboard, the tab strip and tmux all move on the release, not when some
 * animation ends. The picture does not jump, because the tab that switches in
 * is already drawn where it will come to rest: the grid is put back by exactly
 * the offset it was drawn at (`finishing`) and then runs home, with the tab
 * just left sliding out beside it. A slide that falls short slides back
 * (`cancelling`); neither ever reverses. A committed zoom holds the pinch's
 * drawing (`handoff`) until PaneLayout sees the zoom land and animates on from
 * there.
 */

import { assign, enqueueActions } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents, GestureState } from '../../types';
import { selectVisibleWindows } from '../../selectors';
import {
  PINCH_IN_COMMIT,
  PINCH_OUT_COMMIT,
  neighborTab,
  swipeCommits,
  swipeOffsetPx,
  swipeSettleMs,
} from '../../../utils/gestures';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/** The one pending settle timer: a new gesture cancels the last one's. */
const SETTLE_ID = 'gesture-settle';
/** A zoom that never lands in the DOM stops holding the pinch after this long. */
export const ZOOM_HANDOFF_TIMEOUT_MS = 1000;

type PinchMode = Extract<GestureState, { kind: 'pinch' }>['mode'];

/** What a pinch at `scale` would do if the fingers lifted now, or null for nothing. */
function pinchMode(context: Ctx, scale: number): PinchMode | null {
  const { pinchZoom, pinchOverview } = context.gestureFlags;
  if (context.tabOverviewOpen) return pinchOverview && scale > 1 ? 'enter' : null;
  const zoomed = context.windows.find((w) => w.id === context.activeWindowId)?.zoomed;
  if (zoomed) return pinchZoom && scale < 1 ? 'unzoom' : null;
  if (scale > 1) return pinchZoom ? 'zoom' : null;
  return pinchOverview ? 'overview' : null;
}

/** The pane a pinch acts on: the tiled pane under the fingers for a zoom, else the active one. */
function pinchPane(context: Ctx, mode: PinchMode, paneId: string | null): string | null {
  if (mode !== 'zoom') return context.activePaneId;
  const own = context.panes.filter((p) => p.windowId === context.activeWindowId);
  // A lone pane has nothing to zoom over.
  if (own.length < 2) return null;
  return own.find((p) => p.tmuxId === paneId)?.tmuxId ?? context.activePaneId;
}

/** A gesture still under the fingers (or none): the only kind a new pinch step may replace. */
const isTracking = (g: GestureState | null) => !g || g.phase === 'tracking';

export const gesturesActions = {
  gestures_pinch: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'GESTURE_PINCH' || !isTracking(context.gesture)) return;
      if (!context.gesture) enqueue.cancel(SETTLE_ID);
      const mode = pinchMode(context, event.scale);
      const paneId = mode ? pinchPane(context, mode, event.paneId) : null;
      enqueue(
        assign({
          gesture:
            mode && paneId
              ? { kind: 'pinch', mode, scale: event.scale, paneId, phase: 'tracking' }
              : null,
        }),
      );
    },
  ),

  gestures_pinchEnd: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'GESTURE_PINCH_END') return;
      const g = context.gesture;
      if (g?.kind !== 'pinch' || g.phase !== 'tracking') return;
      const out = g.scale >= PINCH_OUT_COMMIT;
      const inward = g.scale <= PINCH_IN_COMMIT;
      if ((g.mode === 'zoom' && out) || (g.mode === 'unzoom' && inward)) {
        enqueue(assign({ gesture: { ...g, phase: 'handoff' } }));
        enqueue.raise({ type: 'ZOOM_PANE', paneId: g.paneId });
        enqueue.raise(
          { type: 'GESTURE_SETTLE' },
          { delay: ZOOM_HANDOFF_TIMEOUT_MS, id: SETTLE_ID },
        );
        return;
      }
      enqueue(assign({ gesture: null }));
      if (g.mode === 'overview' && inward) {
        enqueue.raise({ type: 'TOGGLE_TAB_OVERVIEW' });
      } else if (g.mode === 'enter' && out) {
        // Whatever card the fingers were over: a pinch out goes back into the
        // tab you were in, the way closing the overview does.
        const index = selectVisibleWindows(context).findIndex(
          (w) => w.id === context.activeWindowId,
        );
        enqueue.raise({ type: 'TAB_OVERVIEW_ACTIVATE', index: Math.max(0, index) });
      }
    },
  ),

  gestures_swipe: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'GESTURE_SWIPE') return;
      if (!context.gestureFlags.swipeTabs || context.tabOverviewOpen) return;
      const running = context.gesture;
      // A pinch handing a zoom over owns the grid until it lands. A slide
      // sliding home does not: a new slide takes it over and carries on from
      // where the grid has got to, which is how two quick swipes feel.
      if (running?.kind === 'pinch') return;
      if (!running || running.phase !== 'tracking') enqueue.cancel(SETTLE_ID);
      const neighbor = neighborTab(selectVisibleWindows(context), context.activeWindowId, event.dx);
      enqueue(
        assign({
          gesture: {
            kind: 'swipe',
            dx: event.dx,
            neighborId: neighbor?.id ?? null,
            phase: 'tracking',
            settleMs: 0,
          },
        }),
      );
    },
  ),

  gestures_swipeEnd: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'GESTURE_SWIPE_END') return;
      const g = context.gesture;
      if (g?.kind !== 'swipe' || g.phase !== 'tracking') return;
      enqueue.cancel(SETTLE_ID);
      const width = context.containerWidth;
      if (g.neighborId && swipeCommits(g.dx, event.speed, width)) {
        // Switch now. The tab coming in is drawn one offset to the side of
        // rest, so the grid starts this far off it and runs home - the same
        // picture, moving on at the speed the fingers had.
        const offset = swipeOffsetPx(context.totalWidth, context.charWidth);
        const from = g.dx + (g.dx < 0 ? offset : -offset);
        enqueue(
          assign({
            gesture: {
              kind: 'swipe',
              dx: from,
              // The tab being left, sliding out on the other side.
              neighborId: context.activeWindowId,
              phase: 'finishing',
              settleMs: swipeSettleMs(from, event.speed),
            },
          }),
        );
        enqueue.raise({ type: 'SELECT_TAB', windowId: g.neighborId });
        enqueue.raise(
          { type: 'GESTURE_SETTLE' },
          { delay: swipeSettleMs(from, event.speed), id: SETTLE_ID },
        );
        return;
      }
      const settleMs = swipeSettleMs(g.dx, event.speed);
      enqueue(assign({ gesture: { ...g, dx: 0, phase: 'cancelling', settleMs } }));
      enqueue.raise({ type: 'GESTURE_SETTLE' }, { delay: settleMs, id: SETTLE_ID });
    },
  ),

  gestures_settle: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'GESTURE_SETTLE') return;
      if (context.gesture && context.gesture.phase !== 'tracking') {
        enqueue(assign({ gesture: null }));
      }
    },
  ),
};
