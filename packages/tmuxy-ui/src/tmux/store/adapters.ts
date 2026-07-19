/**
 * Adapter between wire-format ServerState (snake_case) and TmuxSnapshot
 * (camelCase, store-internal). Re-uses the existing `transformServerState`
 * helper that already handles the snake → camel conversion + sort.
 */

import { transformServerState as _transform } from '../../machines/app/helpers';
import { cellLinesEqual } from '../deltaProtocol';
import type { ServerState, TmuxPane, TmuxWindow } from '../types';
import type { TmuxSnapshot } from './types';

export function transformServerState(payload: ServerState): TmuxSnapshot {
  // The helper returns mutable arrays; TmuxSnapshot is `readonly`. The cast
  // is safe — the store never mutates the snapshot in place, it returns
  // fresh objects from reducers.
  return _transform(payload) as TmuxSnapshot;
}

/**
 * Preserve object identity across snapshots for anything that didn't change.
 *
 * Wire snapshots arrive as entirely fresh object graphs (serde/WASM and the
 * demo engine both serialize from scratch), so without this every state tick
 * invalidates every memoized selector and re-renders every pane — typing in
 * one pane repaints the whole app. Reusing the PREVIOUS snapshot's objects
 * when a pane/window is value-equal keeps `Object.is`-based selector caches
 * (and React memo boundaries) effective; within a changed pane, unchanged
 * content LINES keep their identity so the TerminalLine memo comparator
 * still short-circuits.
 */

function preservePane(prev: TmuxPane, next: TmuxPane): TmuxPane {
  // Content: reuse the previous line object wherever the line is value-equal.
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
    prev.inMode === next.inMode &&
    prev.copyCursorX === next.copyCursorX &&
    prev.copyCursorY === next.copyCursorY &&
    prev.alternateOn === next.alternateOn &&
    prev.mouseAnyFlag === next.mouseAnyFlag &&
    prev.paused === next.paused &&
    prev.historySize === next.historySize &&
    prev.selectionPresent === next.selectionPresent &&
    prev.selectionStartX === next.selectionStartX &&
    prev.selectionStartY === next.selectionStartY &&
    prev.cursorShape === next.cursorShape &&
    prev.cursorHidden === next.cursorHidden &&
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
    (prev.groupPanes === next.groupPanes ||
      (prev.groupPanes?.join(',') ?? null) === (next.groupPanes?.join(',') ?? null));
  return same ? prev : next;
}

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
    prev.statusLine === next.statusLine &&
    prev.sessionName === next.sessionName;

  if (panesSame && windowsSame && scalarsSame) return prev;
  return {
    ...next,
    panes: panesSame ? prev.panes : panes,
    windows: windowsSame ? prev.windows : windows,
  };
}
