import { toClientState, type TmuxPane, type TmuxWindow } from '../client';
import type { PaneTree, ServerState } from '../wire';
import { cellLinesEqual } from '../deltaProtocol';
import type { TmuxSnapshot } from './types';

export function transformServerState(payload: ServerState): TmuxSnapshot {
  return toClientState(payload);
}

function preservePane(prev: TmuxPane, next: TmuxPane): TmuxPane {
  let contentSame = prev.content.length === next.content.length;
  const content = next.content.map((line, i) => {
    const prevLine = prev.content[i];
    if (prevLine && cellLinesEqual(prevLine, line)) return prevLine;
    contentSame = false;
    return line;
  });

  const scalarSame =
    prev.cursorX === next.cursorX &&
    prev.cursorY === next.cursorY &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.active === next.active &&
    prev.command === next.command &&
    prev.title === next.title &&
    prev.borderTitle === next.borderTitle &&
    prev.groupId === next.groupId &&
    (prev.groupPos ?? null) === (next.groupPos ?? null) &&
    prev.inMode === next.inMode &&
    prev.copyCursorX === next.copyCursorX &&
    prev.copyCursorY === next.copyCursorY &&
    prev.alternateOn === next.alternateOn &&
    Boolean(prev.marked) === Boolean(next.marked) &&
    prev.mouseAnyFlag === next.mouseAnyFlag &&
    prev.historySize === next.historySize &&
    prev.selectionPresent === next.selectionPresent &&
    prev.selectionStartX === next.selectionStartX &&
    prev.selectionStartY === next.selectionStartY &&
    prev.cursorShape === next.cursorShape &&
    prev.cursorHidden === next.cursorHidden &&
    (prev.paneState ?? null) === (next.paneState ?? null) &&
    (prev.paneAsk ?? null) === (next.paneAsk ?? null) &&
    (prev.paneWidget ?? null) === (next.paneWidget ?? null) &&
    prev.windowId === next.windowId &&
    (prev.images === next.images ||
      JSON.stringify(prev.images ?? null) === JSON.stringify(next.images ?? null));

  if (scalarSame && contentSame) return prev;
  return { ...next, content };
}

function preserveWindow(prev: TmuxWindow, next: TmuxWindow): TmuxWindow {
  const same =
    prev.index === next.index &&
    prev.name === next.name &&
    prev.active === next.active &&
    prev.windowType === next.windowType &&
    prev.floatParent === next.floatParent &&
    prev.floatWidth === next.floatWidth &&
    prev.floatHeight === next.floatHeight &&
    prev.floatDrawer === next.floatDrawer &&
    prev.floatBg === next.floatBg &&
    prev.floatNoheader === next.floatNoheader &&
    Boolean(prev.floatMinimized) === Boolean(next.floatMinimized) &&
    (prev.sidebarCols ?? null) === (next.sidebarCols ?? null) &&
    Boolean(prev.sidebarHidden) === Boolean(next.sidebarHidden) &&
    Boolean(prev.collapsible) === Boolean(next.collapsible) &&
    Boolean(prev.zoomed) === Boolean(next.zoomed) &&
    (prev.activePaneId ?? null) === (next.activePaneId ?? null) &&
    samePaneTree(prev.paneTree ?? null, next.paneTree ?? null);
  return same ? prev : next;
}

function samePaneTree(a: PaneTree | null, b: PaneTree | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return false;
  return (
    a.vertical === b.vertical &&
    a.children.length === b.children.length &&
    a.children.every((child, i) => samePaneTree(child, b.children[i]))
  );
}

/**
 * Wire snapshots arrive as fresh object graphs, so without this every state
 * tick invalidates every memoized selector and repaints every pane. Every field
 * the UI reads must be compared in `preservePane` / `preserveWindow`: one left
 * out pins the old object, and a change to that field alone (a pane's declared
 * state, a zoom, a sidebar's width) never reaches the screen.
 */
export function preserveSnapshotIdentity(prev: TmuxSnapshot, next: TmuxSnapshot): TmuxSnapshot {
  const prevPanes = new Map(prev.panes.map((p) => [p.tmuxId, p]));
  const prevWindows = new Map(prev.windows.map((w) => [w.id, w]));

  let panesSame = prev.panes.length === next.panes.length;
  const panes = next.panes.map((p, i) => {
    const prevPane = prevPanes.get(p.tmuxId);
    const preserved = prevPane ? preservePane(prevPane, p) : p;
    if (preserved !== prev.panes[i]) panesSame = false;
    return preserved;
  });

  let windowsSame = prev.windows.length === next.windows.length;
  const windows = next.windows.map((w, i) => {
    const prevWindow = prevWindows.get(w.id);
    const preserved = prevWindow ? preserveWindow(prevWindow, w) : w;
    if (preserved !== prev.windows[i]) windowsSame = false;
    return preserved;
  });

  const scalarsSame =
    prev.activePaneId === next.activePaneId &&
    prev.activeWindowId === next.activeWindowId &&
    prev.totalWidth === next.totalWidth &&
    prev.totalHeight === next.totalHeight &&
    prev.sessionName === next.sessionName &&
    prev.focusRequest === next.focusRequest &&
    prev.pluginsRev === next.pluginsRev &&
    prev.themeRev === next.themeRev;

  if (panesSame && windowsSame && scalarsSame) return prev;
  return {
    ...next,
    panes: panesSame ? prev.panes : panes,
    windows: windowsSame ? prev.windows : windows,
  };
}
