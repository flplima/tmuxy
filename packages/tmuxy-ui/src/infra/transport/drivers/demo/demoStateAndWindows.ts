import type {
  PaneContent,
  ServerStateEncoded,
  WirePaneEncoded,
  WireWindowEncoded,
} from '../../../../domain/wire';
import type { DemoGroupsContext } from './demoGroupsAndFloats';
import {
  type FakePane,
  type FakeWindow,
  type LayoutNode,
  applyWindowLayout,
  computePositions,
  removeLeaf,
  splitLeaf,
  swapLeafIds,
} from './demoLayout';

export function swapDemoPanes(ctx: DemoGroupsContext, srcId: string, dstId: string): boolean {
  const srcPane = ctx.panes.get(srcId);
  const dstPane = ctx.panes.get(dstId);
  if (!srcPane || !dstPane || srcPane.windowId !== dstPane.windowId) return false;
  const window = ctx.windows.find((w) => w.id === srcPane.windowId);
  if (!window) return false;
  window.layout = swapLeafIds(window.layout, srcId, dstId);
  applyWindowLayout(window, ctx.panes, ctx.totalWidth, ctx.totalHeight);
  return true;
}

export interface DemoStateSnapshotInput {
  sessionName: string;
  activeWindowId: string;
  activePaneId: string;
  markedPaneId: string | null;
  zoomedPaneId: string | null;
  totalWidth: number;
  totalHeight: number;
  panes: Map<string, FakePane>;
  windows: FakeWindow[];
  copyModePanes: Set<string>;
  paneStates: Map<string, string>;
  paneAsks: Map<string, string>;
  paneWidgets: Map<string, string>;
}

export function buildDemoServerState(input: DemoStateSnapshotInput): ServerStateEncoded {
  // Compute pane positions from every window's layout: like the server, the
  // state carries the panes of EVERY window (the Tab Overview draws the
  // other tabs' screens from them; PaneLayout shows only the active one's).
  // Zoom applies to the active window alone.
  const posMap = new Map<
    string,
    { paneId: string; x: number; y: number; width: number; height: number }
  >();
  for (const w of input.windows) {
    // Only tabs tile the surface; a float, sidebar or group window's panes
    // keep their shell's own grid.
    if (w.windowType !== 'tab' || !w.layout) continue;
    const layout =
      input.zoomedPaneId && w.id === input.activeWindowId
        ? ({ type: 'leaf', paneId: input.zoomedPaneId } as LayoutNode)
        : w.layout;
    for (const p of computePositions(layout, 0, 0, input.totalWidth, input.totalHeight)) {
      posMap.set(p.paneId, p);
    }
  }

  // Map each group member to its group id (the group window's id stands in
  // for @tmuxy-group-id). Members carry this on the wire; the group windows
  // themselves are not emitted (they model the hidden stash).
  const groupIdByPane = new Map<string, string>();
  for (const w of input.windows) {
    if (w.windowType !== 'group' || !w.groupPanes) continue;
    for (const pid of w.groupPanes) groupIdByPane.set(pid, w.id);
  }

  const panes: WirePaneEncoded[] = [];
  for (const [, pane] of input.panes) {
    const pos = posMap.get(pane.id);
    // In zoom mode, only show the zoomed pane from the active window
    if (
      input.zoomedPaneId &&
      pane.windowId === input.activeWindowId &&
      pane.id !== input.zoomedPaneId
    )
      continue;
    panes.push({
      id: pane.numericId,
      tmux_id: pane.id,
      window_id: pane.windowId,
      content: pane.shell.getContent(),
      cursor_x: pane.shell.getCursorX(),
      cursor_y: pane.shell.getCursorY(),
      // Panes outside the active window's layout (floats, group members,
      // the sidebar) have no computed position — report their shell's own
      // grid rather than the whole surface, which disagreed with both the
      // shell content and the float_width/float_height metadata.
      width: pos?.width ?? pane.shell.getWidth(),
      // computePositions already returns content-only height (header row excluded).
      height: pos?.height ?? pane.shell.getHeight(),
      x: pos?.x ?? 0,
      y: pos?.y ?? 0,
      active: pane.id === input.activePaneId,
      command: pane.command,
      title: pane.title,
      border_title: '',
      group_id: groupIdByPane.get(pane.id) ?? null,
      in_mode: input.copyModePanes.has(pane.id),
      marked: pane.id === input.markedPaneId,
      copy_cursor_x: 0,
      copy_cursor_y: 0,
      history_size: pane.shell.getHistorySize(),
      cursor_shape: 0,
      cursor_hidden: false,
      pane_state: input.paneStates.get(pane.id) ?? null,
      pane_ask: input.paneAsks.get(pane.id) ?? null,
      pane_widget: input.paneWidgets.get(pane.id) ?? null,
      images: pane.images,
    });
  }

  const windows: WireWindowEncoded[] = input.windows
    // Group windows model the hidden stash: their member panes are emitted
    // (carrying group_id) but the windows themselves are never tabs.
    .filter((w) => w.windowType !== 'group')
    .map((w) => ({
      id: w.id,
      index: w.index,
      name: w.name,
      active: w.id === input.activeWindowId,
      window_type: w.windowType === 'group' ? null : w.windowType,
      float_parent: w.floatParent ?? null,
      float_width: w.floatWidth ?? null,
      float_height: w.floatHeight ?? null,
      float_drawer: w.floatDrawer ?? null,
      float_bg: w.floatBg ?? null,
      float_noheader: w.floatNoheader ?? false,
      sidebar_cols: w.sidebarCols ?? null,
      sidebar_hidden: w.sidebarHidden ?? false,
      collapsible: w.collapsible ?? false,
      // Zoom applies to the active window alone (switching tabs clears it).
      zoomed: input.zoomedPaneId !== null && w.id === input.activeWindowId,
      active_pane_id:
        w.id === input.activeWindowId
          ? input.activePaneId
          : ([...input.panes.values()].find((p) => p.windowId === w.id)?.id ?? null),
    }));

  return {
    session_name: input.sessionName,
    active_window_id: input.activeWindowId,
    active_pane_id: input.activePaneId,
    panes,
    windows,
    total_width: input.totalWidth,
    total_height: input.totalHeight,
  };
}

export function splitDemoPane(
  ctx: DemoGroupsContext,
  direction: 'horizontal' | 'vertical',
): string | null {
  // Unzoom first if zoomed
  ctx.unzoomIfZoomed();

  const window = ctx.windows.find((w) => w.id === ctx.activeWindowId);
  if (!window) return null;

  const paneId = ctx.allocPaneId();
  const parentWidth = ctx.totalWidth;
  const parentHeight = ctx.totalHeight;

  // Compute current active pane content dimensions (subtract header for y=0 panes)
  const positions = computePositions(window.layout, 0, 0, parentWidth, parentHeight);
  const activePos = positions.find((p) => p.paneId === ctx.activePaneId);
  const w = activePos?.width ?? parentWidth;
  const h = activePos?.height ?? parentHeight;

  const newW = direction === 'vertical' ? Math.floor(w / 2) : w;
  const newH = direction === 'horizontal' ? Math.floor(h / 2) : h;

  const shell = ctx.makeShell(paneId, newW, newH);
  shell.writePrompt();

  const pane: FakePane = {
    id: paneId,
    numericId: parseInt(paneId.slice(1)),
    windowId: window.id,
    shell,
    command: 'bash',
    title: '',
  };
  ctx.panes.set(paneId, pane);

  // Split the active pane's leaf in the layout tree
  window.layout = splitLeaf(window.layout, ctx.activePaneId, paneId, direction);

  // Resize existing pane
  const existingPane = ctx.panes.get(ctx.activePaneId);
  if (existingPane) {
    const existW = direction === 'vertical' ? w - newW - 1 : w;
    const existH = direction === 'horizontal' ? h - newH - 1 : h;
    existingPane.shell.resize(Math.max(existW, 1), Math.max(existH, 1));
  }

  ctx.setActivePaneId(paneId);
  applyWindowLayout(window, ctx.panes, ctx.totalWidth, ctx.totalHeight);
  return paneId;
}

export function killDemoPane(ctx: DemoGroupsContext, paneId?: string): boolean {
  const targetId = paneId ?? ctx.activePaneId;
  const pane = ctx.panes.get(targetId);
  if (!pane) return false;

  // Unzoom if zoomed pane is killed
  ctx.unzoomIfZoomed(targetId);

  const window = ctx.windows.find((w) => w.id === pane.windowId);
  if (!window) return false;

  // If it's the last pane in the window, kill the window
  const windowPanes = [...ctx.panes.values()].filter((p) => p.windowId === window.id);
  if (windowPanes.length <= 1) {
    return ctx.killWindow(window.id);
  }

  // Remove from layout
  window.layout = removeLeaf(window.layout, targetId)!;
  ctx.panes.delete(targetId);

  // If active pane was killed, select first remaining pane in window
  if (ctx.activePaneId === targetId) {
    const remaining = [...ctx.panes.values()].find((p) => p.windowId === window.id);
    if (remaining) ctx.setActivePaneId(remaining.id);
  }

  applyWindowLayout(window, ctx.panes, ctx.totalWidth, ctx.totalHeight);
  return true;
}

export function createNewDemoWindow(ctx: DemoGroupsContext): string {
  const windowId = ctx.allocWindowId();
  const paneId = ctx.allocPaneId();

  // Subtract 1 row for header (pane-border-status top occupies row 0)
  const shell = ctx.makeShell(paneId, ctx.totalWidth, Math.max(ctx.totalHeight - 1, 1));
  shell.writePrompt();

  const pane: FakePane = {
    id: paneId,
    numericId: parseInt(paneId.slice(1)),
    windowId,
    shell,
    command: 'bash',
    title: '',
  };
  ctx.panes.set(paneId, pane);

  // Find next available index
  const usedIndices = new Set(ctx.windows.map((w) => w.index));
  let index = 0;
  while (usedIndices.has(index)) index++;

  const window: FakeWindow = {
    id: windowId,
    index,
    name: 'bash',
    manualName: false,
    layout: { type: 'leaf', paneId },
    layoutCycle: 0,
    windowType: 'tab',
    groupPanes: null,
  };
  ctx.windows.push(window);

  ctx.setActiveWindowId(windowId);
  ctx.setActivePaneId(paneId);
  return windowId;
}

export function killDemoWindow(ctx: DemoGroupsContext, windowId?: string): boolean {
  const targetId = windowId ?? ctx.activeWindowId;
  const idx = ctx.windows.findIndex((w) => w.id === targetId);
  if (idx === -1) return false;

  // Remove all panes in this window
  for (const [id, pane] of ctx.panes) {
    if (pane.windowId === targetId) ctx.panes.delete(id);
  }

  ctx.windows.splice(idx, 1);

  // Clear zoom if the zoomed window was killed
  if (ctx.activeWindowId === targetId) {
    ctx.clearZoom();
  }

  // If no tab windows left, create a new one
  const tabWindows = ctx.windows.filter((w) => w.windowType === 'tab');
  if (tabWindows.length === 0) {
    ctx.newWindow();
    return true;
  }

  // If active window was killed, select next tab window (never a sidebar/float/group window)
  if (ctx.activeWindowId === targetId) {
    const newIdx = Math.min(idx, tabWindows.length - 1);
    ctx.selectWindow(tabWindows[newIdx].id);
  }

  return true;
}

/**
 * Reorder the tab strip: put `windowId` before (`after` = false) or after
 * `targetId` among the tab windows, renumbering their indices the way
 * `renumber-windows on` does. Chrome windows keep their own indices.
 */
export function moveTabWindow(
  windows: FakeWindow[],
  windowId: string,
  targetId: string,
  after: boolean,
): boolean {
  const tabs = windows.filter((w) => w.windowType === 'tab').sort((a, b) => a.index - b.index);
  const source = tabs.find((w) => w.id === windowId);
  const target = tabs.find((w) => w.id === targetId);
  if (!source || !target || source === target) return false;
  const rest = tabs.filter((w) => w !== source);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  rest.splice(at, 0, source);
  const indices = tabs.map((w) => w.index);
  rest.forEach((w, i) => {
    w.index = indices[i];
  });
  return true;
}

export function getPaneScrollbackCells(
  panes: Map<string, FakePane>,
  paneId: string,
  start?: number,
  end?: number,
): PaneContent {
  const pane = panes.get(paneId);
  if (!pane) return [];
  const historySize = pane.shell.getHistorySize();
  const height = pane.shell.getContent().length;
  const totalLines = historySize + height;
  // Convert tmux-relative offsets to absolute indices
  // Tmux uses negative offsets for history (e.g., -200 to 0 = last 200 history lines + visible)
  const absStart = start !== undefined ? historySize + start : 0;
  const absEnd = end !== undefined ? historySize + end : totalLines;
  return pane.shell.getScrollbackContent(absStart, absEnd);
}

export function capturePaneText(panes: Map<string, FakePane>, targetId: string): string {
  const pane = panes.get(targetId);
  if (!pane) return '';

  const content = pane.shell.getContent();
  return content
    .map((line) =>
      line
        .map((cell) => cell.c)
        .join('')
        .trimEnd(),
    )
    .join('\n')
    .trimEnd();
}

export function joinPaneBetweenWindows(
  ctx: DemoGroupsContext,
  srcId: string,
  targetWindowId: string,
): boolean {
  const src = ctx.panes.get(srcId);
  if (!src) return false;
  const srcWindow = ctx.windows.find((w) => w.id === src.windowId);
  const targetWindow = ctx.windows.find((w) => w.id === targetWindowId);
  if (!srcWindow || !targetWindow || srcWindow.id === targetWindow.id) return false;

  ctx.unzoomIfZoomed();

  // Split point in the target window: its active pane if that lives here, else
  // the window's first pane.
  const targetPanes = [...ctx.panes.values()].filter((p) => p.windowId === targetWindowId);
  if (targetPanes.length === 0) return false;
  const splitAt = targetPanes.find((p) => p.id === ctx.activePaneId)?.id ?? targetPanes[0].id;

  // Detach src from its window; close the window if src was its last pane.
  const srcPaneCount = [...ctx.panes.values()].filter((p) => p.windowId === srcWindow.id).length;
  if (srcPaneCount <= 1) {
    ctx.setWindows(ctx.windows.filter((w) => w.id !== srcWindow.id));
  } else {
    srcWindow.layout = removeLeaf(srcWindow.layout, srcId)!;
    applyWindowLayout(srcWindow, ctx.panes, ctx.totalWidth, ctx.totalHeight);
  }

  // Attach src into the target window and focus it.
  targetWindow.layout = splitLeaf(targetWindow.layout, splitAt, srcId, 'horizontal');
  src.windowId = targetWindowId;
  ctx.setActivePaneId(srcId);
  ctx.setActiveWindowId(targetWindowId);
  applyWindowLayout(targetWindow, ctx.panes, ctx.totalWidth, ctx.totalHeight);
  return true;
}

export function breakPaneToWindow(ctx: DemoGroupsContext, targetId: string): string | null {
  ctx.unzoomIfZoomed();

  const pane = ctx.panes.get(targetId);
  if (!pane) return null;

  const srcWindow = ctx.windows.find((w) => w.id === pane.windowId);
  if (!srcWindow) return null;

  // Can't break if it's the only pane
  const windowPanes = [...ctx.panes.values()].filter((p) => p.windowId === srcWindow.id);
  if (windowPanes.length <= 1) return null;

  // Remove from source layout
  srcWindow.layout = removeLeaf(srcWindow.layout, targetId)!;

  // If active pane was broken out, select another in source window
  if (ctx.activePaneId === targetId) {
    const remaining = [...ctx.panes.values()].find((p) => p.windowId === srcWindow.id);
    if (remaining) {
      ctx.setActivePaneId(remaining.id);
      ctx.setActiveWindowId(srcWindow.id);
    }
  }
  applyWindowLayout(srcWindow, ctx.panes, ctx.totalWidth, ctx.totalHeight);

  // Create new window for this pane
  const windowId = ctx.allocWindowId();
  const usedIndices = new Set(ctx.windows.map((w) => w.index));
  let index = 0;
  while (usedIndices.has(index)) index++;

  const newWindow: FakeWindow = {
    id: windowId,
    index,
    name: srcWindow.name,
    manualName: false,
    layout: { type: 'leaf', paneId: targetId },
    layoutCycle: 0,
    windowType: 'tab',
    groupPanes: null,
  };
  ctx.windows.push(newWindow);

  // Move pane to new window
  pane.windowId = windowId;
  pane.shell.resize(ctx.totalWidth, ctx.totalHeight - 1);

  // Switch to new window
  ctx.setActivePaneId(targetId);
  ctx.setActiveWindowId(windowId);
  return windowId;
}
