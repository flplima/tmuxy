/**
 * Whether each sidebar column is docked beside the grid or overlays it.
 *
 * A per-viewer choice, kept in this browser: a laptop may dock the tree while
 * a phone on the same session never can, so it is not a session tag. Reloading
 * the page keeps it, the way the font size is kept.
 */

export type SidebarSide = 'left' | 'right';

const LS_KEY = 'tmuxy-sidebar-fixed';

export function loadSidebarFixed(): Record<SidebarSide, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') {
      const { left, right } = parsed as Record<string, unknown>;
      return { left: left === true, right: right === true };
    }
  } catch {
    // localStorage unavailable or the value is not ours
  }
  return { left: false, right: false };
}

export function saveSidebarFixed(fixed: Record<SidebarSide, boolean>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(fixed));
  } catch {
    // localStorage unavailable
  }
}
