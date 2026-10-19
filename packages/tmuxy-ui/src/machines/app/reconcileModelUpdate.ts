/**
 * TMUX_MODEL_UPDATE reconciliation handler for the app machine.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from './actionTypes';
import type { AppMachineContext } from '../types/context';
import type { PaneCellBox } from '../types/domain';
import type { PaneId } from '../../domain/ids';
import type { TmuxClientModel, TmuxSnapshot } from '../../domain/store/types';
import { dragCells, resizedBand } from '../resize/limits';
import { isBoxPermutation, samePanes } from './layoutChange';
import {
  buildGroupsFromPanes,
  buildFloatPanesFromWindows,
  gridExtent,
  keepLivePanes,
} from './helpers';
import { buildScrollbackState, fetchHistory, reconcilePaneMode } from './scrollback';
import { pruneAskSelections } from './actions/ask';
import { nextUnreadPaneIds, normalizePaneState } from '../../utils/paneState';
import { TmuxOp } from '../../domain/commands';
import { reconcileFloatAndSidebarLifecycle } from './reconcileSidebars';

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

export const reconcileModelActions = {
  reconcile_reconnectingModelUpdate: assignCtx(({ event }) => {
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

  reconcile_modelUpdate: act(({ event, context, enqueue }) => {
    if (event.type !== 'TMUX_MODEL_UPDATE') return;
    const transformed = snapshotFromModel(event.model);

    if (transformed.panes.length === 0) return;

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

    enqueue.raise({ type: 'SYNC_DOCK_ROWS' as const });

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

    reconcileFloatAndSidebarLifecycle(context, transformed, floatPanes, enqueue);

    let updatedCopyModeStates = context.copyModeStates;
    const now = Date.now();
    for (const newPane of transformed.panes) {
      const prevPane = context.panes.find((p) => p.tmuxId === newPane.tmuxId);
      const record = context.copyModeStates[newPane.tmuxId];
      switch (reconcilePaneMode(prevPane, newPane, record, { readOnly: context.readOnly, now })) {
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

    const samePaneSet =
      hasDimensionChange &&
      transformed.panes.length === context.panes.length &&
      transformed.panes.every((p) => context.panes.some((cp) => cp.tmuxId === p.tmuxId));
    const isLayoutTransition =
      context.activePaneId !== null &&
      transformed.activePaneId !== null &&
      transformed.panes.some((p) => p.tmuxId === context.activePaneId) &&
      ((context.lastLayoutCommandTime > 0 && Date.now() - context.lastLayoutCommandTime < 500) ||
        samePaneSet);
    const effectiveActivePaneId = isLayoutTransition
      ? context.activePaneId
      : (transformed.activePaneId ?? context.activePaneId);

    const lastActivePaneByWindow = { ...context.lastActivePaneByWindow };
    for (const pane of transformed.panes) {
      if (!context.readOnly && pane.active && pane.windowId) {
        lastActivePaneByWindow[pane.windowId] = pane.tmuxId;
      }
    }

    enqueue(
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
        lastActivePaneByWindow,
        unreadPaneIds: nextUnreadPaneIds(
          ctx.unreadPaneIds,
          ctx.panes,
          transformed.panes,
          effectiveActivePaneId,
        ),
      })),
    );

    const inFront = transformed.panes.find((p) => p.tmuxId === effectiveActivePaneId);
    const wasInFront = context.panes.find((p) => p.tmuxId === effectiveActivePaneId);
    if (
      !context.readOnly &&
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
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_SESSION' as const,
        sessionName: transformed.sessionName,
      }),
    );
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_ACTIVE_PANE' as const,
        paneId: effectiveActivePaneId,
      }),
    );

    const grid = gridExtent(transformed.panes, transformed.activeWindowId, {
      cols: transformed.totalWidth,
      rows: transformed.totalHeight,
    });
    const shouldResize =
      !context.readOnly &&
      context.targetCols > 0 &&
      context.targetRows > 0 &&
      (context.targetCols !== grid.cols || context.targetRows !== grid.rows);
    if (shouldResize) {
      enqueue(
        sendTo('tmux', {
          type: 'INVOKE' as const,
          cmd: 'set_client_size',
          args: { cols: context.targetCols, rows: context.targetRows },
        }),
      );
    }

    if (
      !context.enableAnimations &&
      context.targetCols > 0 &&
      !shouldResize &&
      !hasDimensionChange &&
      context.lastUpdateQuiet
    ) {
      enqueue(assign({ enableAnimations: true }));
    }
  }),
};
