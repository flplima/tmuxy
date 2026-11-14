import { paneJumpOrder } from '../../domain/jumpHints';
import { CONTAINER_PADDING_X } from '../../constants/layout';
import type { AppMachineContext } from '../types/context';
import type { FloatPaneState, SidebarSide } from '../types/domain';
import {
  type PaneGroup,
  paneTakesCopyMode,
  type TmuxPane,
  type TmuxWindow,
} from '../../domain/client';
import { createMemoizedSelector, createMemoizedSelectorWithArg } from './memoize';
import { DEFAULT_CHAR_WIDTH, LEFT_SIDEBAR_COLS, RIGHT_SIDEBAR_COLS } from '../constants';
import type { PaneId, WindowId } from '../../domain/ids';
import type { PaneTree } from '../../domain/wire';
import { sidebarWindow, stripTabs } from '../../domain/windows';
import { previewInputs, selectPreviewPanes, selectSidebarCellMetrics } from './layout';

/** The tabs the strip shows (`isStripTab`). */
export const selectVisibleWindows = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows] as const,
  (context: AppMachineContext) => stripTabs(context.windows),
);

/**
 * The pane behind a sidebar column, or null when that column's window does not
 * exist yet.
 *
 * Each sidebar is a `sidebar-left` / `sidebar-right`-typed window holding
 * exactly one pane, the shape a float window has. It lives outside the active
 * window, so neither `selectPreviewPanes` nor the tab strip sees it: these
 * selectors are the only way the UI reaches it.
 */
function sidebarPane(context: AppMachineContext, side: 'left' | 'right'): TmuxPane | null {
  const window = sidebarWindow(context.windows, side);
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
      ctx.sidebars,
      ctx.measuredCell,
      ctx.baseFontSize,
      ctx.windows,
      ctx.sidebarColsPreview,
    ] as const,
  (
    context: AppMachineContext,
  ): { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number } => {
    // The columns are chrome: measured cells, whatever the grid is fitted to.
    const charWidth = context.measuredCell.charWidth || DEFAULT_CHAR_WIDTH;
    const draggedCols = (side: 'left' | 'right') => {
      const preview = context.sidebarColsPreview;
      if (preview && preview.side === side) return preview.cols;
      return sidebarWindow(context.windows, side)?.sidebarCols ?? null;
    };
    return {
      leftOpen: context.sidebars.left.open,
      rightOpen: context.sidebars.right.open,
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

/** The pane behind `side`'s column. */
export function selectSidebarPane(context: AppMachineContext, side: SidebarSide): TmuxPane | null {
  return side === 'left' ? selectLeftSidebarPane(context) : selectRightSidebarPane(context);
}

/** Whether `side`'s window is hidden (`@tmuxy-sidebar-hidden`): closed for every client. */
export function selectSidebarHidden(context: AppMachineContext, side: SidebarSide): boolean {
  return Boolean(sidebarWindow(context.windows, side)?.sidebarHidden);
}

/**
 * Whether the tree is on screen: its docked column, a peek of it, the
 * phone's bottom view showing it or, held sideways, the phone's left column
 * unless the menu has its place. The sessions it lists are polled only then.
 */
export function selectTreeVisible(context: AppMachineContext): boolean {
  if (context.phoneLayout) {
    return context.phoneLandscape
      ? context.phoneBottomView !== 'menu'
      : context.phoneBottomView === 'tree';
  }
  return context.sidebars.left.open || context.sidebarPeek === 'left';
}

/** The member of a group shown in the active window. */
export function getActivePaneInGroup(context: AppMachineContext, group: PaneGroup): PaneId | null {
  const shown = groupMemberInTab(context, group.paneIds);
  return shown?.windowId === context.activeWindowId ? shown.tmuxId : null;
}

/** The member of a group drawn in a tab, on screen or not (the others are parked in the stash). */
export function groupMemberInTab(
  context: Pick<AppMachineContext, 'panes' | 'windows'>,
  members: readonly PaneId[],
): TmuxPane | null {
  const tabs = new Set(context.windows.filter((w) => w.windowType === 'tab').map((w) => w.id));
  return (
    context.panes.find((p) => members.includes(p.tmuxId) && p.windowId && tabs.has(p.windowId)) ??
    null
  );
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

/** The tiled panes on screen: no floats, and of a group only its shown member. */
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

/**
 * The floats that belong to the tab the user is looking at, bottom-most
 * first, drawn or minimized.
 */
function floatsOfTab(
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

/** The floats drawn over the tab the user is looking at, bottom-most first. */
export function visibleFloats(
  floatPanes: Record<PaneId, FloatPaneState>,
  windows: TmuxWindow[],
  activeWindowId: WindowId | null,
): FloatPaneState[] {
  return floatsOfTab(floatPanes, windows, activeWindowId).filter((float) => !float.minimized);
}

export const selectVisibleFloats = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.floatPanes, ctx.activeWindowId, ctx.windows] as const,
  (context: AppMachineContext): FloatPaneState[] =>
    visibleFloats(context.floatPanes, context.windows, context.activeWindowId),
);

/** The tab's minimized floats, in the queue at its bottom edge, oldest first. */
export const selectMinimizedFloats = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.floatPanes, ctx.activeWindowId, ctx.windows] as const,
  (context: AppMachineContext): FloatPaneState[] =>
    floatsOfTab(context.floatPanes, context.windows, context.activeWindowId).filter(
      (float) => float.minimized,
    ),
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

export const selectPaneGroupForPane = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: PaneId) => ctx.paneGroups,
  (context: AppMachineContext, paneId: PaneId): PaneGroup | undefined => {
    return Object.values(context.paneGroups).find((group) => group.paneIds.includes(paneId));
  },
);

export function selectPaneGroupPanes(context: AppMachineContext, group: PaneGroup): TmuxPane[] {
  return group.paneIds
    .map((id) => context.panes.find((p) => p.tmuxId === id))
    .filter((p): p is TmuxPane => p !== undefined);
}

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

export function selectPaneTakesCopyMode(context: AppMachineContext, paneId: PaneId): boolean {
  return paneTakesCopyMode(context.panes, paneId);
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

/** The tab in front's panes as ctrl+alt+1…9 number them (`domain/jumpHints.ts`). */
export const selectPaneJumpOrder = createMemoizedSelector(
  (ctx: AppMachineContext) => ({ visible: selectVisiblePanes(ctx) }),
  (ctx: AppMachineContext) => paneJumpOrder(selectVisiblePanes(ctx)),
);
