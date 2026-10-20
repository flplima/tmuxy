import { CONTAINER_PADDING_X } from '../../constants/layout';
import type { AppMachineContext } from '../types/context';
import type { FloatPaneState, PaneGroup } from '../types/domain';
import type { TmuxPane, TmuxWindow } from '../../domain/client';
import { createMemoizedSelector, createMemoizedSelectorWithArg } from '../../utils/memoize';
import { DEFAULT_CHAR_WIDTH, LEFT_SIDEBAR_COLS, RIGHT_SIDEBAR_COLS } from '../constants';
import type { PaneId, WindowId } from '../../domain/ids';
import type { PaneTree } from '../../domain/wire';
import { previewInputs, selectPreviewPanes, selectSidebarCellMetrics } from './layout';

// ============================================
// Window & Sidebar Selectors
// ============================================

/**
 * Windows with `active` derived from context.activeWindowId.
 *
 * The server snapshot also carries an `active` boolean per window, but it
 * lags our optimistic SELECT_TAB flip — a snapshot captured before tmux
 * processed `select-window` still marks the old window active, which would
 * make the tab highlight blink (new → old → new) as those snapshots arrive.
 * Deriving from activeWindowId here makes the UI a single source of truth.
 */
export const selectWindows = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.activeWindowId] as const,
  (context: AppMachineContext) =>
    context.windows.map((w) => {
      const shouldBeActive = w.id === context.activeWindowId;
      return w.active === shouldBeActive ? w : { ...w, active: shouldBeActive };
    }),
);

/** Windows visible in the status bar. Only tab-typed windows show as tabs;
 *  group and float windows are hidden, and foreign (untagged) windows are
 *  ignored entirely. */
export const selectVisibleWindows = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.activeWindowId] as const,
  (context: AppMachineContext) =>
    selectWindows(context).filter((w) => w.windowType === 'tab' && w.name !== ''),
);

/**
 * The pane behind a sidebar column, or null when that column's window does not
 * exist yet.
 *
 * Each sidebar is a `sidebar-left` / `sidebar-right`-typed window holding
 * exactly one pane — the same shape a float window has, created by the same
 * `break-pane` + tag command list. It lives outside the active window, so it is
 * invisible to `selectPreviewPanes` (which filters to the active window) and to
 * the tab strip (`selectVisibleWindows` keeps only tabs); these selectors are
 * the only way the UI reaches it.
 */
function sidebarPane(context: AppMachineContext, side: 'left' | 'right'): TmuxPane | null {
  const window = context.windows.find((w) => w.windowType === `sidebar-${side}`);
  if (!window) return null;
  return context.panes.find((p) => p.windowId === window.id) ?? null;
}

/** The pane running the tree widget behind the left column. */
export const selectLeftSidebarPane = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.panes] as const,
  (context: AppMachineContext): TmuxPane | null => sidebarPane(context, 'left'),
);

/**
 * The width the pane area has with the columns that are open, in pixels — the
 * body minus its padding minus the columns docked beside the grid. Null before
 * the body has been measured.
 */
export function selectSettledPaneWidth(context: AppMachineContext): number | null {
  if (context.bodyWidth <= 0) return null;
  const layout = selectSidebarLayout(context);
  const docked =
    (layout.leftOpen ? layout.leftWidth : 0) + (layout.rightOpen ? layout.rightWidth : 0);
  return context.bodyWidth - 2 * CONTAINER_PADDING_X - docked;
}

/**
 * The two columns: which are open, and how wide. A column is always docked
 * beside the grid, whatever the window's size, and opens and shuts at once.
 */
export const selectSidebarLayout = createMemoizedSelector(
  (ctx: AppMachineContext) =>
    [
      ctx.leftSidebarOpen,
      ctx.rightSidebarOpen,
      ctx.charWidth,
      ctx.cellGap,
      ctx.baseFontSize,
      ctx.windows,
      ctx.sidebarColsPreview,
    ] as const,
  (
    context: AppMachineContext,
  ): { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number } => {
    const charWidth = context.charWidth || DEFAULT_CHAR_WIDTH;
    const draggedCols = (side: 'left' | 'right') => {
      const preview = context.sidebarColsPreview;
      if (preview && preview.side === side) return preview.cols;
      return context.windows.find((w) => w.windowType === `sidebar-${side}`)?.sidebarCols ?? null;
    };
    return {
      leftOpen: context.leftSidebarOpen,
      rightOpen: context.rightSidebarOpen,
      leftWidth: (draggedCols('left') ?? LEFT_SIDEBAR_COLS) * charWidth,
      rightWidth:
        (draggedCols('right') ?? RIGHT_SIDEBAR_COLS) * selectSidebarCellMetrics(context).cellWidth,
    };
  },
);

/** The pane running the pinned terminal behind the right column. */
export const selectRightSidebarPane = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.panes] as const,
  (context: AppMachineContext): TmuxPane | null => sidebarPane(context, 'right'),
);

// ============================================
// Pane Group, Visible Panes & Float Selectors
// ============================================

/**
 * Get the active pane ID in a group (derived from which pane is in the active window)
 */
export function getActivePaneInGroup(context: AppMachineContext, group: PaneGroup): PaneId | null {
  for (const paneId of group.paneIds) {
    const pane = context.panes.find((p) => p.tmuxId === paneId);
    if (pane?.windowId === context.activeWindowId) {
      return paneId;
    }
  }
  return null;
}

/** The group members parked out of view: every member but the one in the active window. */
function hiddenGroupPaneIds(context: AppMachineContext): Set<PaneId> {
  const hidden = new Set<PaneId>();
  for (const group of Object.values(context.paneGroups)) {
    const shown = getActivePaneInGroup(context, group);
    for (const paneId of group.paneIds) {
      if (paneId !== shown) hidden.add(paneId);
    }
  }
  return hidden;
}

/**
 * Select visible panes - filters out hidden group panes
 * For groups, only the pane in the active window is visible.
 */
function selectVisiblePanesUncached(context: AppMachineContext): TmuxPane[] {
  let previewPanes = selectPreviewPanes(context);

  const floatPaneIds = context.floatPanes;
  if (Object.keys(floatPaneIds).length > 0) {
    previewPanes = previewPanes.filter((p) => !floatPaneIds[p.tmuxId]);
  }

  const hidden = hiddenGroupPaneIds(context);
  const result =
    hidden.size === 0 ? previewPanes : previewPanes.filter((pane) => !hidden.has(pane.tmuxId));

  return [...result].sort((a, b) => (a.tmuxId < b.tmuxId ? -1 : a.tmuxId > b.tmuxId ? 1 : 0));
}

/** tmux's marked pane (`select-pane -m`) in the attached session, or null. */
export const selectMarkedPaneId = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.panes] as const,
  (context: AppMachineContext): string | null =>
    context.panes.find((p) => p.marked)?.tmuxId ?? null,
);

/**
 * The floats that belong to the tab the user is looking at, bottom-most first.
 */
export function visibleFloats(
  floatPanes: Record<PaneId, FloatPaneState>,
  windows: TmuxWindow[],
  activeWindowId: WindowId | null,
): FloatPaneState[] {
  return Object.values(floatPanes).filter((float) => {
    const parent = float.parentWindowId;
    if (parent === null) return true;
    if (parent === activeWindowId) return true;
    return !windows.some((w) => w.id === parent);
  });
}

export const selectVisibleFloats = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.floatPanes, ctx.activeWindowId, ctx.windows] as const,
  (context: AppMachineContext): FloatPaneState[] =>
    visibleFloats(context.floatPanes, context.windows, context.activeWindowId),
);

export const selectVisiblePanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    ...previewInputs(ctx),
    paneGroups: ctx.paneGroups,
    floatPanes: ctx.floatPanes,
  }),
  selectVisiblePanesUncached,
);

/**
 * Panes that belong to non-active, non-float windows. PaneLayout renders these
 * with `display: none` so their <TerminalPane> instances stay mounted across
 * tab switches.
 */
function selectHiddenWindowPanesUncached(context: AppMachineContext): TmuxPane[] {
  const { panes, activeWindowId, floatPanes, windows } = context;
  if (!activeWindowId) return [];

  const hidden = hiddenGroupPaneIds(context);

  const sidebarWindowIds = new Set(
    windows.filter((w) => w.windowType?.startsWith('sidebar-')).map((w) => w.id),
  );

  const result: TmuxPane[] = [];
  for (const pane of panes) {
    if (pane.windowId === activeWindowId) continue;
    if (sidebarWindowIds.has(pane.windowId)) continue;
    if (floatPanes[pane.tmuxId]) continue;
    if (hidden.has(pane.tmuxId)) continue;
    result.push(pane);
  }
  return result.sort((a, b) => (a.tmuxId < b.tmuxId ? -1 : a.tmuxId > b.tmuxId ? 1 : 0));
}

export const selectHiddenWindowPanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    paneGroups: ctx.paneGroups,
    activeWindowId: ctx.activeWindowId,
    floatPanes: ctx.floatPanes,
    windows: ctx.windows,
  }),
  selectHiddenWindowPanesUncached,
);

/**
 * Find the group that contains a given pane (if any)
 */
export const selectPaneGroupForPane = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: PaneId) => ctx.paneGroups,
  (context: AppMachineContext, paneId: PaneId): PaneGroup | undefined => {
    return Object.values(context.paneGroups).find((group) => group.paneIds.includes(paneId));
  },
);

/**
 * Get all panes in a group (resolved from pane IDs)
 */
export function selectPaneGroupPanes(context: AppMachineContext, group: PaneGroup): TmuxPane[] {
  return group.paneIds
    .map((id) => context.panes.find((p) => p.tmuxId === id))
    .filter((p): p is TmuxPane => p !== undefined);
}

// ============================================
// Single Pane & Active Tree Selectors
// ============================================

const selectPreviewPaneMap = createMemoizedSelector(
  previewInputs,
  (context: AppMachineContext): Map<PaneId, TmuxPane> => {
    const previewPanes = selectPreviewPanes(context);
    const map = new Map<PaneId, TmuxPane>();
    for (const pane of previewPanes) {
      map.set(pane.tmuxId, pane);
    }
    return map;
  },
);

export const selectPaneById = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: PaneId) => previewInputs(ctx),
  (context: AppMachineContext, paneId: PaneId): TmuxPane | undefined => {
    const paneMap = selectPreviewPaneMap(context);
    return paneMap.get(paneId) ?? context.panes.find((p) => p.tmuxId === paneId);
  },
);

export function selectIsPaneInActiveWindow(context: AppMachineContext, paneId: PaneId): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return pane?.windowId === context.activeWindowId;
}

/**
 * Whether copy mode means anything on the pane. A pane running a widget (a
 * preview, the tree) draws its own view, and under it the pane's text is only
 * the widget's marker: there is nothing there to scroll back through or copy.
 */
export function selectPaneTakesCopyMode(context: AppMachineContext, paneId: PaneId): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return !!pane && !pane.paneWidget;
}

export function selectIsSinglePane(context: AppMachineContext): boolean {
  return selectVisiblePanes(context).length === 1;
}

export function selectGroupSwitchPaneIds(context: AppMachineContext): Set<PaneId> | null {
  const ids = context.groupSwitchPaneIds;
  if (ids.length === 0) return null;
  return new Set(ids);
}

/** The active window's split structure, which the dividers follow; null until tmux reports one. */
export function selectActivePaneTree(context: AppMachineContext): PaneTree | null {
  return context.windows.find((w) => w.id === context.activeWindowId)?.paneTree ?? null;
}
