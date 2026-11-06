/**
 * The browser's selection over terminal rows, drawn the way a terminal draws
 * one: every row the selection runs past is selected to the pane's edge.
 *
 * A native selection paints the glyphs it covers and nothing else, so on a
 * terminal grid — rows trimmed of trailing blanks — a selection across lines
 * showed ragged right edges and left an empty row looking unselected, though
 * the copy takes it. iTerm2 and every other terminal fill the row instead:
 * the first row from where the selection starts, the middle rows entirely, the
 * last row up to where it ends. Each row the selection runs past — every
 * selected row but the last — is marked, and the stylesheet fills the rest of
 * that row (`terminal-line-selected-on`, styles/terminal.css). Nothing about
 * what is selected or copied changes.
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

/** Mark the rows `selection` runs past, and unmark the rest. */
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
