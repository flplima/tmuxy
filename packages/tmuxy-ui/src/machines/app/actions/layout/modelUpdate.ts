/**
 * TMUX_MODEL_UPDATE: the store's derived snapshot mirrored into the context,
 * with what follows from the change (groups and floats rebuilt, copy-mode
 * records reconciled, the columns' lifecycle, the size this client asks for).
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../../actionTypes';
import type { AppMachineContext } from '../../../types/context';
import type { PaneCellBox } from '../../../types/domain';
import type { PaneId } from '../../../../domain/ids';
import type { TmuxClientModel, TmuxSnapshot } from '../../../../domain/store/types';
import { dragCells, resizedBand } from '../../../resize/limits';
import { isBoxPermutation, samePanes } from '../../layoutChange';
import {
  buildGroupsFromPanes,
  buildFloatPanesFromWindows,
  closeScrollViewsIn,
  gridExtent,
  keepLivePanes,
} from '../../helpers';
import { buildScrollbackState, fetchHistory, reconcilePaneMode } from '../copyMode/scrollback';
import { pruneAskSelections } from '../ask';
import { normalizePaneState } from '../../../../domain/paneState';
import { TmuxOp } from '../../../../domain/commands';
import { reconcileFloats } from '../groupsAndFloats';
import { reconcileSidebars } from '../sidebars';
import { syncClientSize } from '../viewport';

/** `T` without its readonly, arrays included: a store snapshot as the context declares it. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

/**
 * The store's derived snapshot as a fresh object the model update can adjust
 * before it is assigned.
 */
export function snapshotFromModel(model: TmuxClientModel): Mutable<TmuxSnapshot> {
  return { ...model.derived } as Mutable<TmuxSnapshot>;
}

function resizePreviewSettled(
  resize: NonNullable<AppMachineContext['resize']>,
  panes: ReadonlyArray<PaneCellBox & { tmuxId: PaneId }>,
  charWidth: number,
  charHeight: number,
): boolean {
  const band = resizedBand(
    resize.bandGeometry,
    resize.paneId,
    resize.handle,
    dragCells(resize, charWidth, charHeight),
  );
  return (Object.keys(band) as PaneId[]).every((id) => {
    const want = band[id];
    const got = panes.find((p) => p.tmuxId === id);
    return (
      got !== undefined &&
      got.x === want.x &&
      got.y === want.y &&
      got.width === want.width &&
      got.height === want.height
    );
  });
}

function updateActivationOrder(order: PaneId[], paneId: PaneId | null): PaneId[] {
  if (!paneId) return order;
  return [paneId, ...order.filter((id) => id !== paneId)];
}

export const layoutModelUpdateActions = {
  layout_reconnectingModelUpdate: assignCtx(({ event }) => {
    if (event.type !== 'TMUX_MODEL_UPDATE') return {};
    const transformed = snapshotFromModel(event.model);
    return {
      panes: transformed.panes,
      windows: transformed.windows,
      activePaneId: transformed.activePaneId,
      activeWindowId: transformed.activeWindowId,
      totalWidth: transformed.totalWidth,
      totalHeight: transformed.totalHeight,
    };
  }),

  layout_modelUpdate: act(({ event, context, enqueue }) => {
    if (event.type !== 'TMUX_MODEL_UPDATE') return;
    const transformed = snapshotFromModel(event.model);

    if (transformed.panes.length === 0) return;

    // The backend gives every tab `pane-border-status top` (and sidebars
    // `off`, tmuxy-core control_mode/state/window_state.rs), so a tab's
    // topmost pane sits at y=1 under the row its header is drawn in. A pane
    // already on screen that a layout reports at y=0 (before the option has
    // taken effect on its window) is drawn a row down and a row shorter, so
    // it never slides up under its header for an update.
    if (!context.resizeActive) {
      const borderlessWindowIds = new Set(
        transformed.windows
          .filter((w) => w.windowType === 'sidebar-left' || w.windowType === 'sidebar-right')
          .map((w) => w.id),
      );
      transformed.panes = transformed.panes.map((np) => {
        if (np.y !== 0) return np;
        if (borderlessWindowIds.has(np.windowId)) return np;
        const prev = context.panes.find((o) => o.tmuxId === np.tmuxId);
        if (!prev) return np;
        return { ...np, y: 1, height: Math.max(1, np.height - 1) };
      });
    }

    const switchingWindow = transformed.activeWindowId !== context.activeWindowId;
    const newActiveHasPanes = transformed.panes.some(
      (p) => p.windowId === transformed.activeWindowId,
    );
    const currentlyRenderingPanes = context.panes.some(
      (p) => p.windowId === context.activeWindowId,
    );
    const opsInFlight = event.model.ops.length > 0;
    if (!opsInFlight && switchingWindow && !newActiveHasPanes && currentlyRenderingPanes) return;

    enqueue.raise({ type: 'SYNC_DOCK_SIZE' as const });

    const structurallyChanged =
      transformed.panes.length !== context.panes.length ||
      transformed.activeWindowId !== context.activeWindowId ||
      transformed.windows.length !== context.windows.length ||
      transformed.windows.some((w, i) => {
        const prev = context.windows[i];
        if (!prev) return true;
        if (w.name !== prev.name) return true;
        if (w.windowType !== prev.windowType) return true;
        if (
          w.floatDrawer !== prev.floatDrawer ||
          w.floatWidth !== prev.floatWidth ||
          w.floatHeight !== prev.floatHeight ||
          w.floatBg !== prev.floatBg ||
          w.floatNoheader !== prev.floatNoheader ||
          Boolean(w.sidebarHidden) !== Boolean(prev.sidebarHidden) ||
          Boolean(w.zoomed) !== Boolean(prev.zoomed)
        ) {
          return true;
        }
        return false;
      }) ||
      transformed.panes.some((p) => {
        const prev = context.panes.find((cp) => cp.tmuxId === p.tmuxId);
        return (
          p.windowId !== prev?.windowId ||
          (p.groupId ?? null) !== (prev?.groupId ?? null) ||
          (p.groupPos ?? null) !== (prev?.groupPos ?? null)
        );
      });

    const paneGroups = structurallyChanged
      ? buildGroupsFromPanes(transformed.panes)
      : context.paneGroups;

    let floatPanes = structurallyChanged
      ? buildFloatPanesFromWindows(
          transformed.windows,
          transformed.panes,
          context.floatPanes,
          context.containerWidth,
          context.containerHeight,
          context.charWidth,
          context.charHeight,
        )
      : context.floatPanes;

    const currentPaneIdSet = new Set(transformed.panes.map((p) => p.tmuxId));
    floatPanes = keepLivePanes(floatPanes, currentPaneIdSet);

    reconcileFloats(context, { ...transformed, floatPanes }, enqueue);
    reconcileSidebars(
      context,
      { ...context, windows: transformed.windows, panes: transformed.panes },
      transformed.focusRequest,
      enqueue,
    );

    if (transformed.pluginsRev !== context.pluginsRev) {
      enqueue.raise({ type: 'PLUGINS_REV_CHANGED', rev: transformed.pluginsRev });
    }
    if (transformed.themeRev !== context.themeRev) {
      enqueue.raise({ type: 'THEME_REV_CHANGED', rev: transformed.themeRev });
    }

    let updatedCopyModeStates = context.copyModeStates;
    const now = Date.now();
    for (const newPane of transformed.panes) {
      const prevPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
      const record = context.copyModeStates[newPane.tmuxId];
      switch (
        reconcilePaneMode(prevPane, newPane, record, {
          now,
          exitedAt: context.copyModeExitedAt[newPane.tmuxId],
        })
      ) {
        case 'confirm': {
          updatedCopyModeStates = {
            ...updatedCopyModeStates,
            [newPane.tmuxId]: { ...record, tmuxSeen: true },
          };
          break;
        }
        case 'leave': {
          updatedCopyModeStates = { ...updatedCopyModeStates };
          delete updatedCopyModeStates[newPane.tmuxId];
          break;
        }
        case 'enter': {
          const enteredRecord = buildScrollbackState(newPane, 'copy', { tmuxSeen: true });
          updatedCopyModeStates = { ...updatedCopyModeStates, [newPane.tmuxId]: enteredRecord };
          fetchHistory(enqueue, newPane.tmuxId, enteredRecord);
          break;
        }
        case 'none':
          break;
      }
    }

    updatedCopyModeStates = keepLivePanes(updatedCopyModeStates, currentPaneIdSet);
    if (context.activeWindowId && transformed.activeWindowId !== context.activeWindowId) {
      updatedCopyModeStates = closeScrollViewsIn(
        updatedCopyModeStates,
        transformed.panes,
        context.activeWindowId,
      );
    }

    const hasDimensionChange =
      !context.resizeActive &&
      transformed.panes.some((newPane) => {
        const oldPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
        return (
          oldPane &&
          (oldPane.x !== newPane.x ||
            oldPane.y !== newPane.y ||
            oldPane.width !== newPane.width ||
            oldPane.height !== newPane.height)
        );
      });

    const heldResize =
      context.resizeActive ||
      (context.resize !== null &&
        !(
          !hasDimensionChange &&
          context.lastUpdateQuiet &&
          resizePreviewSettled(
            context.resize,
            transformed.panes,
            context.charWidth,
            context.charHeight,
          )
        ))
        ? context.resize
        : null;

    const animateGeometry =
      hasDimensionChange &&
      context.lastUpdateQuiet &&
      heldResize === null &&
      samePanes(context.panes, transformed.panes) &&
      !isBoxPermutation(context.panes, transformed.panes);

    const effectiveActivePaneId = transformed.activePaneId ?? context.activePaneId;

    enqueue(
      // cross-cutting: the store's snapshot is mirrored into every slice that derives from it.
      assign(({ context: ctx }) => ({
        ...transformed,
        activePaneId: effectiveActivePaneId,
        paneGroups,
        floatPanes,
        askSelections: pruneAskSelections({ ...ctx, panes: transformed.panes }),
        copyModeStates: updatedCopyModeStates,
        resize: heldResize,
        suppressLayoutTransition: animateGeometry
          ? false
          : hasDimensionChange || (!ctx.lastUpdateQuiet && !ctx.lastUpdateAnimated),
        lastUpdateQuiet: !hasDimensionChange,
        lastUpdateAnimated: animateGeometry,
        groupSwitchPaneIds: event.model.ops.flatMap((pendingOp) =>
          pendingOp.op._tag === 'GroupSwitch' && pendingOp.op.visiblePaneId
            ? [pendingOp.op.clickedPaneId, pendingOp.op.visiblePaneId]
            : [],
        ),
        paneKeyOverrides: event.model.paneKeyOverrides,
        paneActivationOrder:
          effectiveActivePaneId !== ctx.activePaneId
            ? updateActivationOrder(ctx.paneActivationOrder, effectiveActivePaneId)
            : ctx.paneActivationOrder,
      })),
    );

    const inFront = transformed.panes.find((p) => p.tmuxId === effectiveActivePaneId);
    const wasInFront = context.panes.find((p) => p.tmuxId === effectiveActivePaneId);
    if (
      inFront &&
      normalizePaneState(inFront.paneState) === 'unread' &&
      !(
        context.activePaneId === inFront.tmuxId &&
        normalizePaneState(wasInFront?.paneState) === 'unread'
      )
    ) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.ClearPaneState({ paneId: inFront.tmuxId }),
        }),
      );
    }

    enqueue(
      sendTo('tmuxStore', ({ context: ctx }) => ({
        type: 'UPDATE_PREDICT_CONTEXT' as const,
        defaultShell: ctx.defaultShell,
        paneActivationOrder: ctx.paneActivationOrder,
      })),
    );

    const grid = gridExtent(transformed.panes, transformed.activeWindowId, {
      cols: transformed.totalWidth,
      rows: transformed.totalHeight,
    });
    // A window sized for another client is drawn in a cell fitted to it.
    if (context.sizePolicy.mode !== 'smallest') {
      const before = gridExtent(context.panes, context.activeWindowId, {
        cols: context.totalWidth,
        rows: context.totalHeight,
      });
      if (before.cols !== grid.cols || before.rows !== grid.rows) {
        enqueue.raise({ type: 'REFIT_GRID' as const });
      }
    }
    syncClientSize(
      { ...context, ...transformed, connected: true },
      enqueue,
      { cols: context.targetCols, rows: context.targetRows },
      !hasDimensionChange && context.lastUpdateQuiet,
    );
  }),
};
