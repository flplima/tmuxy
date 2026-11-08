/**
 * The browser's selection over terminal rows, drawn as iTerm2 and other
 * terminals draw one: every row it runs past is selected to the pane's edge.
 * A native selection paints only the glyphs it covers, so on rows trimmed of
 * trailing blanks it showed ragged edges and empty rows looked unselected.
 * Marked rows are filled by the stylesheet (styles/terminal.css).
 */

import {
  dot,
  TERMINAL_LINE,
  TERMINAL_LINE_SELECTED,
  TERMINAL_SELECTABLE,
} from '../../infra/dom/terminalDom';

let marked = new Set<Element>();

function rowOf(node: Node | null): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest(dot(TERMINAL_LINE)) ?? null;
}

export function markSelectedRows(selection: Selection | null): void {
  const next = new Set<Element>();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const first = rowOf(range.startContainer);
    const last = rowOf(range.endContainer);
    const grid = (first ?? last)?.closest(dot(TERMINAL_SELECTABLE));
    if (grid && first !== last) {
      for (const row of grid.querySelectorAll(dot(TERMINAL_LINE))) {
        if (row !== last && range.intersectsNode(row)) next.add(row);
      }
    }
  }
  for (const row of marked) if (!next.has(row)) row.classList.remove(TERMINAL_LINE_SELECTED);
  for (const row of next) row.classList.add(TERMINAL_LINE_SELECTED);
  marked = next;
}
