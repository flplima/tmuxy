import { raise } from 'xstate';
import { groupMembers, type PaneGroup, type TmuxPane, type TmuxWindow } from '../../domain/client';
import { isModelPaneId, type GroupId, type PaneId, type WindowId } from '../../domain/ids';
import type {
  DrawerDirection,
  FloatBackdrop,
  FloatPaneState,
  KeyboardOwner,
} from '../types/domain';
import type { Ctx, EnqueueAction } from './actionTypes';
import { fitGridCell, fixedGridSize, type GridCell } from '../../domain/gridFit';
import { gridExtent } from '../../domain/paneGeometry';

/**
 * Hand the keyboard to `owner`. Exactly one surface holds it, so taking it is
 * all a surface does: the one that had it lets go by the same step. The
 * keyboard slice makes the change, and the keyboard actor follows it.
 */
export function takeKeyboard(enqueue: EnqueueAction, owner: KeyboardOwner) {
  enqueue(raise({ type: 'TAKE_KEYBOARD' as const, owner }));
}

/**
 * Give the keyboard back to the panes if `from` holds it: a column that was
 * hidden or vanished, a float that closed, a peek that ended.
 */
export function releaseKeyboard(enqueue: EnqueueAction, from: KeyboardOwner['kind']) {
  enqueue(raise({ type: 'RELEASE_KEYBOARD' as const, from }));
}

/**
 * The grid's cell for this context: the measured cell, fitted to the window
 * when `@tmuxy-size` sized it for someone else (domain/gridFit.ts). A fixed
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

// The delayed CLEAR_STATUS_MESSAGE raise's id: a newer message cancels and
// re-schedules it, so the previous message's timer never clears it early.
export const STATUS_MESSAGE_CLEAR_ID = 'statusMessageClear';

/**
 * `record` without the entries of panes that no longer exist — the same
 * object when every pane is still alive, so an unchanged record keeps its
 * identity.
 */
/**
 * `prev` when `next` holds the same entries (each a flat record, an array
 * field compared item by item), else `next`: a rebuilt record that changed
 * nothing keeps its identity, so what reads it does not re-render.
 */
export function keepIfSame<K extends string, V extends object>(
  prev: Record<K, V>,
  next: Record<K, V>,
): Record<K, V> {
  const keys = Object.keys(next) as K[];
  if (keys.length !== Object.keys(prev).length) return next;
  const same = (a: unknown, b: unknown) =>
    a === b ||
    (Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => item === b[i]));
  for (const key of keys) {
    const was = prev[key] as Record<string, unknown> | undefined;
    const is = next[key] as Record<string, unknown>;
    if (!was) return next;
    const fields = Object.keys(is);
    if (fields.length !== Object.keys(was).length) return next;
    if (!fields.every((f) => same(was[f], is[f]))) return next;
  }
  return prev;
}

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
 * Float metadata (drawer, backdrop, no-header) comes from the window's
 * `@tmuxy-float-*` options; each float window holds exactly one pane.
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

    const pane = panes.find((p) => p.windowId === window.id);
    if (!pane) continue;
    const paneId = pane.tmuxId;

    const drawer = (window.floatDrawer as DrawerDirection | null) ?? undefined;
    const backdrop = (window.floatBg as FloatBackdrop | null) ?? undefined;
    const hideHeader = window.floatNoheader || undefined;
    const minimized = window.floatMinimized || undefined;
    // @tmuxy-float-width/height (in cells) are the float's REQUESTED size —
    // authoritative when present, and the grid the backend sizes the float's
    // window to (tmuxy-core `constants::float_grid`), so the pane a program runs in is
    // the size drawn here. The pane's tmux size is the fallback for a float
    // that names none.
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
        minimized,
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
        minimized,
      };
    }
  }

  return floatPanes;
}

/**
 * The id of a side's delayed SIDEBAR_START_TIMEOUT. A fresh start's raise
 * replaces the previous one under the same id, and the pane landing or the
 * start failing cancels it, so a timer from an earlier open never judges a
 * later one.
 */
export function sidebarStartTimeoutId(side: 'left' | 'right'): string {
  return `sidebar-start-timeout-${side}`;
}
