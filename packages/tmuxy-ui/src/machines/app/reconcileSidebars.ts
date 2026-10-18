/**
 * Sidebar and float-focus lifecycle reconciliation during TMUX_MODEL_UPDATE.
 */

import { assign, sendTo } from 'xstate';
import type { Ctx, Enqueue } from './actionTypes';
import type { FloatPaneState } from '../types/domain';
import type { TmuxPane, TmuxWindow } from '../../domain/client';
import type { PaneId, WindowId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  visibleFloats,
} from '../selectors/panesAndSidebars';
import { releaseKeyboard } from './helpers';

export function reconcileFloatAndSidebarLifecycle(
  context: Ctx,
  transformed: {
    windows: TmuxWindow[];
    panes: TmuxPane[];
    activeWindowId: WindowId | null;
    focusRequest?: string | null;
  },
  floatPanes: Record<PaneId, FloatPaneState>,
  enqueue: Enqueue,
): void {
  // Detect float removal — check for session switch env var
  const prevFloatCount = Object.keys(context.floatPanes).length;
  const newFloatCount = Object.keys(floatPanes).length;
  if (!context.readOnly && prevFloatCount > 0 && newFloatCount < prevFloatCount) {
    enqueue(sendTo('tmux', { type: 'CHECK_SESSION_SWITCH' as const }));
  }

  // Auto-focus float management over the floats of the active tab
  const visibleFloatIds = visibleFloats(
    floatPanes,
    transformed.windows,
    transformed.activeWindowId,
  ).map((f) => f.paneId);
  const prevVisibleFloatIds = visibleFloats(
    context.floatPanes,
    context.windows,
    context.activeWindowId,
  ).map((f) => f.paneId);
  const addedFloatIds = visibleFloatIds.filter((id) => !prevVisibleFloatIds.includes(id));
  let newFocusedFloat = context.focusedFloatPaneId;
  if (addedFloatIds.length > 0) {
    newFocusedFloat = visibleFloatIds[visibleFloatIds.length - 1];
    enqueue(assign({ enableAnimations: false }));
  } else if (newFocusedFloat && !visibleFloatIds.includes(newFocusedFloat)) {
    newFocusedFloat =
      visibleFloatIds.length > 0 ? visibleFloatIds[visibleFloatIds.length - 1] : null;
  }
  if (newFocusedFloat !== context.focusedFloatPaneId) {
    enqueue(assign({ focusedFloatPaneId: newFocusedFloat }));
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_FOCUSED_FLOAT' as const,
        paneId: newFocusedFloat,
      }),
    );
  }

  const nextSidebarCtx = {
    ...context,
    windows: transformed.windows,
    panes: transformed.panes,
  };

  const sidebarHidden = (ctx: typeof context, side: 'left' | 'right') =>
    Boolean(ctx.windows.find((w) => w.windowType === `sidebar-${side}`)?.sidebarHidden);

  const prevTreePane = selectLeftSidebarPane(context);
  const nextTreePane = selectLeftSidebarPane(nextSidebarCtx);
  const nextTreeHidden = sidebarHidden(nextSidebarCtx, 'left');
  if (!prevTreePane && nextTreePane) {
    const requestedByThisClient = context.leftSidebarOpen;
    enqueue(assign({ leftSidebarOpen: !nextTreeHidden, leftSidebarStartFailed: false }));
    if (requestedByThisClient && !nextTreeHidden) {
      enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' });
      enqueue(assign({ enableAnimations: false }));
    }
  } else if (prevTreePane && !nextTreePane) {
    const failedStart = context.leftSidebarStarting;
    enqueue(
      assign({
        leftSidebarOpen: failedStart,
        leftSidebarStartFailed: failedStart,
        leftSidebarStarting: false,
      }),
    );
    releaseKeyboard(context, enqueue, 'left');
  } else if (prevTreePane && nextTreePane && sidebarHidden(context, 'left') !== nextTreeHidden) {
    enqueue(assign({ leftSidebarOpen: !nextTreeHidden }));
    if (nextTreeHidden) releaseKeyboard(context, enqueue, 'left');
  }

  const prevDockPane = selectRightSidebarPane(context);
  const nextDockPane = selectRightSidebarPane(nextSidebarCtx);
  const nextDockHidden = sidebarHidden(nextSidebarCtx, 'right');
  if (!prevDockPane && nextDockPane) {
    const requestedByThisClient = context.rightSidebarOpen;
    enqueue(assign({ rightSidebarOpen: !nextDockHidden, rightSidebarStartFailed: false }));
    if (requestedByThisClient && !nextDockHidden) {
      enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
      enqueue(assign({ enableAnimations: false }));
    }
  } else if (prevDockPane && !nextDockPane) {
    const failedStart = context.rightSidebarStarting;
    enqueue(
      assign({
        rightSidebarOpen: failedStart,
        rightSidebarStartFailed: failedStart,
        rightSidebarStarting: false,
      }),
    );
    releaseKeyboard(context, enqueue, 'right');
  } else if (prevDockPane && nextDockPane && sidebarHidden(context, 'right') !== nextDockHidden) {
    enqueue(assign({ rightSidebarOpen: !nextDockHidden }));
    if (nextDockHidden) releaseKeyboard(context, enqueue, 'right');
  }

  const preview = context.sidebarColsPreview;
  if (preview) {
    const win = nextSidebarCtx.windows.find((w) => w.windowType === `sidebar-${preview.side}`);
    if (win && (win.sidebarCols ?? null) === preview.cols) {
      enqueue(assign({ sidebarColsPreview: null }));
    }
  }

  if (transformed.focusRequest && !context.readOnly) {
    const request = transformed.focusRequest;
    if (request === 'left') enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' });
    else if (request === 'right') enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
    else if (request === 'panes') {
      enqueue.raise({ type: 'BLUR_LEFT_SIDEBAR' });
      enqueue.raise({ type: 'BLUR_RIGHT_SIDEBAR' });
    }
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.ClearFocusRequest({ session: context.sessionName }),
      }),
    );
  }
}
