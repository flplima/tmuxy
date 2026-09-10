/**
 * Dropping a dragged pane on the tab strip.
 *
 * A pane drag is driven by the drag machine's own window-level pointer
 * listeners, so the strip never sees a pointer event of its own and cannot
 * decide anything itself. The geometry is therefore measured once, when the
 * drag starts, and the hit test that runs on every move is pure arithmetic
 * over that snapshot — the strip cannot reflow mid-drag, since dropping on it
 * is the only thing the gesture can do there.
 *
 * Over a tab, the pane joins that tab. Over the empty space after the last
 * tab, it becomes a tab of its own.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TabStripGeometry {
  /** The whole strip, including the empty space after the last tab. */
  strip: Rect;
  tabs: Array<{ windowId: string; rect: Rect }>;
}

/** Where a pane dropped on the strip would land. */
export type TabDrop = { kind: 'tab'; windowId: string } | { kind: 'new' };

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Read the strip's boxes out of the DOM. Null when no strip is rendered. */
export function measureTabStrip(): TabStripGeometry | null {
  const list = document.querySelector('.tab-list');
  if (!list) return null;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('.tab-name[data-window-id]'))
    .map((el) => ({ windowId: el.dataset.windowId ?? '', rect: toRect(el) }))
    .filter((t) => t.windowId !== '');
  return { strip: toRect(list), tabs };
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * The drop the pointer is over, or null when it is not on the strip at all.
 *
 * Only the vertical band has to match for the empty space: a pointer past the
 * last tab is aiming at a new tab whether or not it is over a gap between two
 * of them, and asking it to also miss every tab box would make the target a
 * few pixels wide.
 */
export function tabStripDrop(
  geometry: TabStripGeometry | null,
  x: number,
  y: number,
): TabDrop | null {
  if (!geometry || !contains(geometry.strip, x, y)) return null;
  const over = geometry.tabs.find((t) => contains(t.rect, x, y));
  if (over) return { kind: 'tab', windowId: over.windowId };
  return { kind: 'new' };
}

/** Whether two drops name the same place. */
export function sameTabDrop(a: TabDrop | null, b: TabDrop | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind !== 'tab' || b.kind !== 'tab' || a.windowId === b.windowId;
}

/**
 * The tmux command a drop runs, or null when the drop would do nothing: onto
 * the pane's own tab, or into a new tab when the pane is already alone in one
 * (tmux refuses to break the only pane out of a window).
 */
export function tabDropCommand(
  drop: TabDrop,
  paneId: string,
  paneWindowId: string,
  panesInWindow: number,
): string | null {
  if (drop.kind === 'tab') {
    if (drop.windowId === paneWindowId) return null;
    return `join-pane -s ${paneId} -t ${drop.windowId}`;
  }
  if (panesInWindow <= 1) return null;
  return `break-pane -s ${paneId}`;
}
