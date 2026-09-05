/**
 * Pure geometry for the Tab Overview (the Safari-style "all tabs" view).
 *
 * A slot draws a tab's pane layout to scale as a wireframe: each pane becomes a
 * box positioned by percentages of the tab's own grid extent, so the drawing
 * keeps the tab's proportions whatever size the slot ends up. The active tab's
 * slot is different — the live pane grid itself zooms out into it — but its
 * slot still needs the same footprint for the FLIP target, so the geometry
 * helpers are shared.
 */

import type { TmuxPane, TmuxWindow } from '../machines/types';

/**
 * An optimistic placeholder (a tab the client predicted but tmux has not
 * confirmed yet) has no `@id` to target: closing or moving it must wait.
 */
export const isPlaceholderId = (id: string): boolean => id.startsWith('__placeholder_');

/** A pane drawn inside a slot, in percent of the slot's box. */
export interface SlotBox {
  paneId: string;
  /** What the pane runs (or its title) — the box's caption. */
  label: string;
  active: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The pane's screen, drawn to scale inside the box. */
  content: TmuxPane['content'];
  cols: number;
  rows: number;
}

/** One overview slot: a tab and its wireframe. The trailing "+" slot has no window. */
export interface OverviewSlot {
  kind: 'tab';
  window: TmuxWindow;
  /** 1-based position in the tab strip, the number the user sees. */
  position: number;
  boxes: SlotBox[];
}

/**
 * Wireframe boxes for one tab from the pane geometry tmux reports (cells,
 * relative to the window; the top row is the pane-border row, so `y` starts at
 * 1). Percentages are taken over the tab's own extent so a half-height window
 * still fills its slot.
 */
export function slotBoxes(panes: readonly TmuxPane[], windowId: string): SlotBox[] {
  const own = panes.filter((p) => p.windowId === windowId && !isPlaceholderId(p.tmuxId));
  if (own.length === 0) return [];
  const minX = Math.min(...own.map((p) => p.x));
  const minY = Math.min(...own.map((p) => p.y));
  const width = Math.max(1, Math.max(...own.map((p) => p.x + p.width)) - minX);
  const height = Math.max(1, Math.max(...own.map((p) => p.y + p.height)) - minY);
  return own.map((p) => ({
    paneId: p.tmuxId,
    label: p.title || p.command,
    active: p.active,
    left: ((p.x - minX) / width) * 100,
    top: ((p.y - minY) / height) * 100,
    width: (p.width / width) * 100,
    height: (p.height / height) * 100,
    content: p.content,
    cols: p.width,
    rows: p.height,
  }));
}

/**
 * The panes the overview draws: the live panes (so a tab created while it is
 * open gets a slot with boxes) with each pane's screen frozen to the still
 * taken when the overview opened, where one exists.
 */
export function stillPanes(
  live: readonly TmuxPane[],
  snapshot: Record<string, TmuxPane> | null,
): TmuxPane[] {
  if (!snapshot) return [...live];
  return live.map((p) => {
    const still = snapshot[p.tmuxId];
    return still ? { ...p, content: still.content } : p;
  });
}

/** The slots in strip order, one per visible tab (the "+" slot is the caller's). */
export function overviewSlots(
  visibleWindows: readonly TmuxWindow[],
  panes: readonly TmuxPane[],
): OverviewSlot[] {
  return visibleWindows.map((window, i) => ({
    kind: 'tab',
    window,
    position: i + 1,
    boxes: slotBoxes(panes, window.id),
  }));
}

/**
 * Where a dragged slot lands: the index it should be inserted at, given the
 * slots' centre x/y positions and the pointer. The pointer picks the nearest
 * row first, then the first slot in that row whose centre is right of it, so
 * dragging in a wrapped grid reads the way the eye does.
 */
export function dropIndex(
  centers: ReadonlyArray<{ x: number; y: number }>,
  pointer: { x: number; y: number },
): number {
  if (centers.length === 0) return 0;
  const rows = [...new Set(centers.map((c) => c.y))];
  const rowY = rows.reduce(
    (best, y) => (Math.abs(y - pointer.y) < Math.abs(best - pointer.y) ? y : best),
    rows[0],
  );
  let index = 0;
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    if (c.y !== rowY) continue;
    if (pointer.x < c.x) return i;
    index = i + 1;
  }
  return index;
}

/**
 * The tmux command that puts `windowId` at strip position `toIndex`
 * (0-based, among the visible tabs, after removing it from its old place).
 * `move-window -b` inserts before a target window, `-a` after one, and
 * `renumber-windows` keeps the strip order equal to the index order; chrome
 * windows (floats, sidebars) are never targets, so they stay where they are.
 */
export function reorderCommand(
  visibleWindows: readonly TmuxWindow[],
  windowId: string,
  toIndex: number,
): string | null {
  if (isPlaceholderId(windowId)) return null;
  const from = visibleWindows.findIndex((w) => w.id === windowId);
  if (from === -1) return null;
  const others = visibleWindows.filter((w) => w.id !== windowId && !isPlaceholderId(w.id));
  const clamped = Math.max(0, Math.min(toIndex, others.length));
  if (clamped === from) return null;
  if (clamped >= others.length) {
    return `move-window -a -s ${windowId} -t ${others[others.length - 1].id}`;
  }
  return `move-window -b -s ${windowId} -t ${others[clamped].id}`;
}
