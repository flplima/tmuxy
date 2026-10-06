/**
 * Helper functions for the app machine
 */

import { groupMembers } from '../../domain/client';
import { isModelPaneId, type GroupId, type PaneId, type WindowId } from '../../domain/ids';
import type {
  DrawerDirection,
  FloatBackdrop,
  FloatPaneState,
  PaneGroup,
  TmuxPane,
  TmuxWindow,
} from '../types';

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
      // to leave margin around the container edges.
      const isHorizontalDrawer = drawer === 'left' || drawer === 'right';
      const isVerticalDrawer = drawer === 'top' || drawer === 'bottom';
      const defaultWidth = isVerticalDrawer
        ? containerWidth
        : (metaWidth ?? Math.min(pane.width * charWidth, containerWidth - 100));
      const defaultHeight = isHorizontalDrawer
        ? containerHeight
        : (metaHeight ?? Math.min(pane.height * charHeight, containerHeight - 100));
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
