import { LEFT_SIDEBAR_COLS, RIGHT_SIDEBAR_COLS } from '../../../../machines/constants';
import type { DemoShell } from './DemoShell';
import {
  type CreateFloatOptions,
  type FakePane,
  type FakeWindow,
  FLOAT_DEFAULT_COLS,
  FLOAT_DEFAULT_ROWS,
  GROUP_WINDOW_INDEX_BASE,
  applyWindowLayout,
  computePositions,
  containsPane,
  replaceLeafId,
} from './demoLayout';

export interface DemoGroupsContext {
  panes: Map<string, FakePane>;
  windows: FakeWindow[];
  activeWindowId: string;
  activePaneId: string;
  zoomedPaneId: string | null;
  totalWidth: number;
  totalHeight: number;
  allocPaneId: () => string;
  allocWindowId: () => string;
  makeShell: (paneId: string, width: number, height: number) => DemoShell;
  setActivePaneId: (paneId: string) => void;
  setActiveWindowId: (windowId: string) => void;
  setWindows: (windows: FakeWindow[]) => void;
  unzoomIfZoomed: (onlyPaneId?: string) => void;
  clearZoom: () => void;
  newWindow: () => string;
  selectWindow: (windowId: string) => boolean;
  killWindow: (windowId: string) => boolean;
  writeWidget: (paneId: string, widgetName: string, lines: string[]) => void;
  selectPaneByDirection: (direction: string) => boolean;
}

export function createDemoSidebar(
  ctx: DemoGroupsContext,
  side: 'left' | 'right',
  widget?: string,
): string | null {
  const existing = ctx.windows.find((w) => w.windowType === `sidebar-${side}`);
  if (existing) return null;

  const paneId = ctx.allocPaneId();
  const windowId = ctx.allocWindowId();
  const cols = side === 'left' ? LEFT_SIDEBAR_COLS : RIGHT_SIDEBAR_COLS;

  const shell = ctx.makeShell(paneId, cols, ctx.totalHeight);
  shell.writePrompt();

  ctx.panes.set(paneId, {
    id: paneId,
    numericId: parseInt(paneId.slice(1)),
    windowId,
    shell,
    command: 'bash',
    title: '',
  });

  const usedIndices = new Set(ctx.windows.map((w) => w.index));
  let index = GROUP_WINDOW_INDEX_BASE;
  while (usedIndices.has(index)) index++;

  ctx.windows.push({
    id: windowId,
    index,
    name: side === 'left' ? 'tree' : 'terminal',
    manualName: true,
    layout: { type: 'leaf', paneId },
    layoutCycle: 0,
    windowType: `sidebar-${side}`,
    groupPanes: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
    floatWidth: null,
    floatHeight: null,
  });

  if (widget) ctx.writeWidget(paneId, widget, []);
  // Don't switch active window — a sidebar docks beside the tab, it isn't one.
  return paneId;
}

export function setDemoSidebarCols(
  ctx: DemoGroupsContext,
  windowId: string,
  cols: number | null,
): void {
  const window = ctx.windows.find((w) => w.id === windowId);
  if (!window) return;
  window.sidebarCols = cols;
  const width =
    cols ?? (window.windowType === 'sidebar-left' ? LEFT_SIDEBAR_COLS : RIGHT_SIDEBAR_COLS);
  for (const pane of ctx.panes.values()) {
    if (pane.windowId === windowId) pane.shell.resize(width, ctx.totalHeight);
  }
}

export function createDemoFloat(
  ctx: DemoGroupsContext,
  options: CreateFloatOptions = {},
): string | null {
  const paneId = ctx.allocPaneId();
  const windowId = ctx.allocWindowId();
  const numericId = parseInt(paneId.slice(1));

  // Width and height are in tmux columns/rows. The defaults mirror
  // bin/tmuxy/float-create: 60x15 cells, the height capped to the window it
  // floats over.
  const floatW = options.width ?? Math.min(FLOAT_DEFAULT_COLS, ctx.totalWidth);
  const floatH = options.height ?? Math.min(FLOAT_DEFAULT_ROWS, ctx.totalHeight);

  const shell = ctx.makeShell(paneId, floatW, floatH);
  shell.writePrompt();

  const pane: FakePane = {
    id: paneId,
    numericId,
    windowId,
    shell,
    command: 'bash',
    title: '',
  };
  ctx.panes.set(paneId, pane);

  const usedIndices = new Set(ctx.windows.map((w) => w.index));
  let index = GROUP_WINDOW_INDEX_BASE;
  while (usedIndices.has(index)) index++;

  const window: FakeWindow = {
    id: windowId,
    index,
    name: 'float',
    manualName: true,
    layout: { type: 'leaf', paneId },
    layoutCycle: 0,
    windowType: 'float',
    groupPanes: null,
    // A float belongs to the tab it was opened over, exactly as
    // bin/tmuxy/float-create tags it, so the UI can keep it on that tab.
    floatParent: ctx.activeWindowId,
    floatDrawer: options.drawer ?? null,
    floatBg: options.bg ?? null,
    floatNoheader: options.hideHeader ?? false,
    floatWidth: options.width ?? null,
    floatHeight: options.height ?? null,
  };
  ctx.windows.push(window);

  // Don't switch active window — floats are overlays
  return paneId;
}

/** Add the active pane to a group, creating a new sibling pane in the group */
export function demoGroupAdd(ctx: DemoGroupsContext, paneId?: string): string | null {
  const targetId = paneId ?? ctx.activePaneId;
  const pane = ctx.panes.get(targetId);
  if (!pane) return null;

  // Create a new pane to add to the group
  const newPaneId = ctx.allocPaneId();
  const newNumericId = parseInt(newPaneId.slice(1));

  // Get the target pane's dimensions
  const window = ctx.windows.find((w) => w.id === pane.windowId);
  if (!window) return null;
  const positions = computePositions(window.layout, 0, 0, ctx.totalWidth, ctx.totalHeight);
  const pos = positions.find((p) => p.paneId === targetId);
  const w = pos?.width ?? ctx.totalWidth;
  const h = pos?.height ?? ctx.totalHeight;

  const shell = ctx.makeShell(newPaneId, w, h);
  shell.writePrompt();

  // Find existing group for this pane
  const existingGroup = findGroupForPane(ctx.windows, targetId);
  const groupPaneIds = existingGroup
    ? [...(existingGroup.groupPanes ?? []), newPaneId]
    : [targetId, newPaneId];

  // Resolve the group window the new pane belongs to. Only allocate a window
  // id in the create branch: allocating it unconditionally left the new pane
  // pointing at a window that was never created, corrected only as a side
  // effect of swapGroupPanes — so if that early-returned the pane was
  // permanently invisible.
  let groupWindow: FakeWindow;
  if (existingGroup) {
    existingGroup.groupPanes = groupPaneIds;
    groupWindow = existingGroup;
  } else {
    const usedIndices = new Set(ctx.windows.map((w2) => w2.index));
    let index = GROUP_WINDOW_INDEX_BASE;
    while (usedIndices.has(index)) index++;

    groupWindow = {
      id: ctx.allocWindowId(),
      index,
      name: 'group',
      manualName: true,
      layout: { type: 'leaf', paneId: newPaneId },
      layoutCycle: 0,
      windowType: 'group',
      groupPanes: groupPaneIds,
    };
    ctx.windows.push(groupWindow);
  }

  const newPane: FakePane = {
    id: newPaneId,
    numericId: newNumericId,
    windowId: groupWindow.id,
    shell,
    command: 'bash',
    title: '',
  };
  ctx.panes.set(newPaneId, newPane);

  // Swap the new pane into view (replace target in the active layout)
  swapGroupPanes(ctx, targetId, newPaneId, window, groupWindow);

  return newPaneId;
}

/** Close a pane from its group */
export function demoGroupClose(ctx: DemoGroupsContext, paneId?: string): boolean {
  const targetId = paneId ?? ctx.activePaneId;
  const pane = ctx.panes.get(targetId);
  if (!pane) return false;

  const groupWindow = findGroupForPane(ctx.windows, targetId);
  if (!groupWindow) return false;

  const groupPaneIds = groupWindow.groupPanes;
  if (!groupPaneIds || groupPaneIds.length < 2) return false;

  // If the target is visible (in active window), swap another in first
  const activeWindow = ctx.windows.find((w) => w.id === ctx.activeWindowId);
  if (activeWindow && containsPane(activeWindow.layout, targetId)) {
    const nextPaneId = groupPaneIds.find((id) => id !== targetId);
    if (nextPaneId) {
      swapGroupPanes(ctx, targetId, nextPaneId, activeWindow, groupWindow);
    }
  }

  // Remove the pane
  ctx.panes.delete(targetId);

  // Update group membership; dissolve if only one pane left.
  const remainingIds = groupPaneIds.filter((id) => id !== targetId);
  if (remainingIds.length < 2) {
    ctx.killWindow(groupWindow.id);
  } else {
    groupWindow.groupPanes = remainingIds;
  }

  return true;
}

/** Switch to a specific pane in a group */
export function demoGroupSwitch(ctx: DemoGroupsContext, targetPaneId: string): boolean {
  const pane = ctx.panes.get(targetPaneId);
  if (!pane) return false;

  const groupWindow = findGroupForPane(ctx.windows, targetPaneId);
  if (!groupWindow) return false;

  const activeWindow = ctx.windows.find((w) => w.id === ctx.activeWindowId);
  if (!activeWindow) return false;

  // Find which pane from the group is currently visible
  const groupPaneIds = groupWindow.groupPanes;
  if (!groupPaneIds) return false;

  const visibleId = groupPaneIds.find((id) => containsPane(activeWindow.layout, id));
  if (!visibleId || visibleId === targetPaneId) return false;

  swapGroupPanes(ctx, visibleId, targetPaneId, activeWindow, groupWindow);
  return true;
}

/** Navigate to next pane in group */
export function demoGroupNext(ctx: DemoGroupsContext, paneId?: string): boolean {
  const targetId = paneId ?? ctx.activePaneId;
  const groupWindow = findGroupForPane(ctx.windows, targetId);
  if (!groupWindow) return false;

  const groupPaneIds = groupWindow.groupPanes;
  if (!groupPaneIds || groupPaneIds.length < 2) return false;

  const idx = groupPaneIds.indexOf(targetId);
  if (idx === -1) return false;

  const nextIdx = (idx + 1) % groupPaneIds.length;
  return demoGroupSwitch(ctx, groupPaneIds[nextIdx]);
}

/** Navigate to previous pane in group */
export function demoGroupPrev(ctx: DemoGroupsContext, paneId?: string): boolean {
  const targetId = paneId ?? ctx.activePaneId;
  const groupWindow = findGroupForPane(ctx.windows, targetId);
  if (!groupWindow) return false;

  const groupPaneIds = groupWindow.groupPanes;
  if (!groupPaneIds || groupPaneIds.length < 2) return false;

  const idx = groupPaneIds.indexOf(targetId);
  if (idx === -1) return false;

  const prevIdx = (idx - 1 + groupPaneIds.length) % groupPaneIds.length;
  return demoGroupSwitch(ctx, groupPaneIds[prevIdx]);
}

/**
 * Navigate left/right: the neighbouring group member first, without
 * wrapping, then the neighbouring split (mirrors bin/tmuxy/nav). From the
 * last member of a group, right moves on to the pane on the right.
 */
export function demoNavHorizontal(ctx: DemoGroupsContext, direction: 'left' | 'right'): void {
  const activeWindow = ctx.windows.find((w) => w.id === ctx.activeWindowId);
  if (!activeWindow) return;

  const groupPaneIds = findGroupForPane(ctx.windows, ctx.activePaneId)?.groupPanes;
  if (groupPaneIds && groupPaneIds.length > 1) {
    const visibleId = groupPaneIds.find((id) => containsPane(activeWindow.layout, id));
    if (visibleId) {
      const next = groupPaneIds.indexOf(visibleId) + (direction === 'right' ? 1 : -1);
      if (next >= 0 && next < groupPaneIds.length) {
        demoGroupSwitch(ctx, groupPaneIds[next]);
        return;
      }
    }
  }

  ctx.selectPaneByDirection(direction === 'right' ? 'Right' : 'Left');
}

/** Find the group window containing a pane */
export function findGroupForPane(windows: FakeWindow[], paneId: string): FakeWindow | undefined {
  return windows.find((w) => w.windowType === 'group' && (w.groupPanes ?? []).includes(paneId));
}

/** Swap a visible pane with a hidden group pane */
function swapGroupPanes(
  ctx: DemoGroupsContext,
  visibleId: string,
  hiddenId: string,
  activeWindow: FakeWindow,
  groupWindow: FakeWindow,
): void {
  const visiblePane = ctx.panes.get(visibleId);
  const hiddenPane = ctx.panes.get(hiddenId);
  if (!visiblePane || !hiddenPane) return;

  // Swap in layout: replace visible with hidden in active window
  activeWindow.layout = replaceLeafId(activeWindow.layout, visibleId, hiddenId);

  // Move hidden pane to active window
  hiddenPane.windowId = activeWindow.id;

  // Move visible pane to group window
  visiblePane.windowId = groupWindow.id;
  groupWindow.layout = { type: 'leaf', paneId: visibleId };

  // Update active pane
  ctx.setActivePaneId(hiddenId);

  applyWindowLayout(activeWindow, ctx.panes, ctx.totalWidth, ctx.totalHeight);
}
