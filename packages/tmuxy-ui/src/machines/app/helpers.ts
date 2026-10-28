/**
 * Helper functions for the app machine
 */

import { assign, sendTo } from 'xstate';
import { groupMembers } from '../../domain/client';
import { isModelPaneId, type GroupId, type PaneId, type WindowId } from '../../domain/ids';
import type { DrawerDirection, FloatBackdrop, FloatPaneState, PaneGroup } from '../types/domain';
import type { TmuxPane, TmuxWindow } from '../../domain/client';
import type { Ctx, EnqueueAction } from './actionTypes';
import { fitGridCell, fixedGridSize, type GridCell } from '../../utils/gridFit';

/** The surfaces that can hold the keyboard away from the tiled panes. */
export type KeyboardSurface = 'left' | 'right' | 'float';

/**
 * Take the keyboard back from a surface, when it holds it: the focus flag
 * here and the keyboard actor's record of it, which is what re-aims the next
 * keystroke. Exactly one surface holds the keyboard, so whatever takes it —
 * a pane click, a group tab, the other column — releases the others through
 * this; a column that vanished or was hidden releases itself the same way.
 */
export function releaseKeyboard(context: Ctx, enqueue: EnqueueAction, surface: KeyboardSurface) {
  if (surface === 'left') {
    if (!context.leftSidebarFocused) return;
    enqueue(assign({ leftSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: false }));
  } else if (surface === 'right') {
    if (!context.rightSidebarFocused) return;
    enqueue(assign({ rightSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
  } else {
    if (!context.focusedFloatPaneId) return;
    enqueue(assign({ focusedFloatPaneId: null }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: null }));
  }
}

/**
 * The grid's extent in cells: the far edges of the panes in the active
 * window — what the client draws and sizes its viewport against. Every
 * other window's panes (hidden group members, floats, sidebars, a tab left
 * at an older size) live in their own layouts and must not count, or the
 * client compares its viewport with a size it can never reach and asks tmux
 * for a resize on every update. Falls back to every pane when the active
 * window has none, and to the server's own numbers when there are no panes.
 */
export function gridExtent(
  panes: ReadonlyArray<Pick<TmuxPane, 'windowId' | 'x' | 'y' | 'width' | 'height'>>,
  activeWindowId: WindowId | null,
  fallback: { cols: number; rows: number },
): { cols: number; rows: number } {
  const inWindow = activeWindowId ? panes.filter((p) => p.windowId === activeWindowId) : [];
  const extent = inWindow.length > 0 ? inWindow : panes;
  if (extent.length === 0) return fallback;
  return {
    cols: Math.max(...extent.map((p) => p.x + p.width)),
    rows: Math.max(...extent.map((p) => p.y + p.height)),
  };
}

/**
 * The grid's cell for this context: the measured cell, fitted to the window
 * when `@tmuxy-size` sized it for someone else (utils/gridFit.ts). A fixed
 * size fits the grid it asks for, even before tmux has applied it; the
 * phone layout keeps its own cut cell.
 */
export function fittedGridCell(
  context: Pick<
    Ctx,
    | 'measuredCell'
    | 'sizePolicy'
    | 'phoneLayout'
    | 'panes'
    | 'activeWindowId'
    | 'totalWidth'
    | 'totalHeight'
    | 'containerWidth'
    | 'containerHeight'
    | 'baseFontSize'
  >,
): GridCell {
  if (context.phoneLayout) return context.measuredCell;
  const grid =
    fixedGridSize(context.sizePolicy) ??
    gridExtent(context.panes, context.activeWindowId, {
      cols: context.totalWidth,
      rows: context.totalHeight,
    });
  return fitGridCell({
    measured: context.measuredCell,
    policy: context.sizePolicy,
    grid,
    container: { width: context.containerWidth, height: context.containerHeight },
    fontPx: context.baseFontSize,
  });
}

export const STATUS_MESSAGE_DURATION = 5000;

// Shared id for the delayed CLEAR_STATUS_MESSAGE raise. Re-scheduling with the
// same id (after cancel) means a newer status message restarts the window
// instead of the previous message's timer clearing it early — the actor owns
// the timer, so it is cancelled automatically when the machine stops.
export const STATUS_MESSAGE_CLEAR_ID = 'statusMessageClear';

/**
 * `record` without the entries of panes that no longer exist — the same
 * object when every pane is still alive, so an unchanged record keeps its
 * identity.
 */
export function keepLivePanes<V>(
  record: Record<PaneId, V>,
  live: ReadonlySet<PaneId>,
): Record<PaneId, V> {
  const kept: Record<PaneId, V> = {};
  let dropped = false;
  for (const id of Object.keys(record)) {
    if (isModelPaneId(id) && live.has(id)) kept[id] = record[id];
    else dropped = true;
  }
  return dropped ? kept : record;
}

/**
 * The scrollback records with every scroll view on tab `windowId` closed.
 *
 * A scroll view is the client's own: tmux knows nothing of it, and it hides
 * the pane's live screen behind old history. Left open on a tab the user
 * switched away from, it held that pane on whatever they had scrolled to
 * while its program went on printing, and the tab came back to it. Copy mode
 * stays: the pane really is in it, and leaving is tmux's business.
 *
 * Applied wherever the current tab changes: a tab picked in this client
 * (`SELECT_TAB`, which switches before tmux answers, closes them with
 * `EXIT_SCROLL_MODE`) and a switch the model update reports.
 */
export function closeScrollViewsIn(
  states: Ctx['copyModeStates'],
  panes: ReadonlyArray<{ tmuxId: PaneId; windowId: WindowId | null }>,
  windowId: WindowId | null,
): Ctx['copyModeStates'] {
  const closing = scrollViewsIn({ copyModeStates: states, panes }, windowId);
  if (closing.length === 0) return states;
  const next = { ...states };
  for (const paneId of closing) delete next[paneId];
  return next;
}

/** The panes on tab `windowId` with a scroll view open. */
export function scrollViewsIn(
  context: {
    copyModeStates: Ctx['copyModeStates'];
    panes: ReadonlyArray<{ tmuxId: PaneId; windowId: WindowId | null }>;
  },
  windowId: WindowId | null,
): PaneId[] {
  return context.panes
    .filter(
      (pane) =>
        pane.windowId === windowId && context.copyModeStates[pane.tmuxId]?.mode === 'scroll',
    )
    .map((pane) => pane.tmuxId);
}

/**
 * Build pane groups from panes.
 *
 * Group membership is intrinsic to each pane via `@tmuxy-group-id` (e.g. `g5`) —
 * the visible member (a real pane in the active session) and each hidden member
 * (a stub emitted from the stash session) all carry the same id. A group is any
 * id shared by two or more panes, its members in the group's order
 * (`groupMembers`).
 */
export function buildGroupsFromPanes(panes: TmuxPane[]): Record<GroupId, PaneGroup> {
  const ids = new Set<GroupId>();
  for (const pane of panes) if (pane.groupId) ids.add(pane.groupId);

  const groups: Record<GroupId, PaneGroup> = {};
  for (const gid of ids) {
    const paneIds = groupMembers(panes, gid);
    if (paneIds.length < 2) continue;
    groups[gid] = { id: gid, paneIds };
  }
  return groups;
}

/**
 * Build float pane states from float-typed windows.
 * Float metadata (drawer, backdrop, no-header) is sourced from @tmuxy-float-*
 * options on the window; each float window contains exactly one pane.
 */

export function buildFloatPanesFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  existingFloats: Record<PaneId, FloatPaneState>,
  containerWidth: number,
  containerHeight: number,
  charWidth: number,
  charHeight: number,
): Record<PaneId, FloatPaneState> {
  const floatPanes: Record<PaneId, FloatPaneState> = {};

  for (const window of windows) {
    if (window.windowType !== 'float') continue;

    // A float window contains exactly one pane.
    const pane = panes.find((p) => p.windowId === window.id);
    if (!pane) continue;
    const paneId = pane.tmuxId;

    const drawer = (window.floatDrawer as DrawerDirection | null) ?? undefined;
    const backdrop = (window.floatBg as FloatBackdrop | null) ?? undefined;
    const hideHeader = window.floatNoheader || undefined;
    // @tmuxy-float-width/height (in cells) are the float's REQUESTED size —
    // authoritative when present. The pane's tmux size is only a fallback: a
    // single-pane float window can't be shrunk by resize-pane, so on some
    // backends the pane stays session-sized even though the user asked for a
    // 40-col float.
    const metaWidth = window.floatWidth ? window.floatWidth * charWidth : null;
    const metaHeight = window.floatHeight ? window.floatHeight * charHeight : null;
    const existing = existingFloats[paneId];

    if (existing) {
      // Preserve pane-derived dimensions (avoids churn as the underlying pane
      // resizes) but let explicit size metadata and flags win.
      floatPanes[paneId] = {
        ...existing,
        parentWindowId: window.floatParent ?? null,
        width: metaWidth ?? existing.width,
        height: metaHeight ?? existing.height,
        drawer,
        backdrop,
        hideHeader,
      };
    } else {
      // Default dimensions: requested size, else the pane's actual size. Cap
      // to leave margin around the container edges, in whole cells so the
      // float centres with the remainder split evenly on both sides.
      const isHorizontalDrawer = drawer === 'left' || drawer === 'right';
      const isVerticalDrawer = drawer === 'top' || drawer === 'bottom';
      const defaultWidth = isVerticalDrawer
        ? containerWidth
        : (metaWidth ??
          Math.min(pane.width, Math.floor((containerWidth - 100) / charWidth)) * charWidth);
      const defaultHeight = isHorizontalDrawer
        ? containerHeight
        : (metaHeight ??
          Math.min(pane.height, Math.floor((containerHeight - 100) / charHeight)) * charHeight);
      floatPanes[paneId] = {
        paneId,
        parentWindowId: window.floatParent ?? null,
        width: defaultWidth,
        height: defaultHeight,
        drawer,
        backdrop,
        hideHeader,
      };
    }
  }

  return floatPanes;
}
