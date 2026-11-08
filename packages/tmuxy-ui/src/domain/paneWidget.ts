/**
 * Which widget a pane is showing: the `@tmuxy-pane-widget` tag, confirmed by
 * the marker `tmuxy-widget` prints on screen.
 */

import type { PaneContent } from './wireCells';
import { WIDGET_MARKER } from './tmuxyConstants.gen';

export interface PaneWidget {
  name: string;
  lines: string[];
}

const rowText = (row: PaneContent[number]): string => row.map((cell) => cell.c).join('');

/**
 * The widget a pane is showing, or null for a terminal.
 *
 * `authorizedWidget` is the pane's `@tmuxy-pane-widget` option, written by
 * `tmuxy-widget` out of band. It is required, because the marker itself
 * travels in pane OUTPUT: `cat` of a crafted file, a commit message in
 * `git log`, `curl` output or an ssh MOTD could otherwise replace the pane
 * with a widget the user never asked for. The marker must also name that same
 * widget, so a pane running one widget is not turned into another by
 * something it prints.
 *
 * No marker on screen means a stale tag over a live shell (a widget killed
 * without its EXIT trap running), which renders as the terminal.
 *
 * The marker may sit below a shell prompt, and in a pane narrower than it the
 * terminal wraps it over several rows; a wrapped row is full to its last
 * column, so rows are joined while the marker runs to a row's end.
 */
export function findPaneWidget(
  content: PaneContent,
  authorizedWidget: string | null | undefined,
): PaneWidget | null {
  if (!authorizedWidget) return null;
  const marker = WIDGET_MARKER + authorizedWidget;
  for (let i = 0; i < content.length; i++) {
    const end = markerEnd(content, i, marker);
    if (end === null) continue;
    return {
      name: authorizedWidget,
      lines: content.slice(end + 1).map((row) => rowText(row).trimEnd()),
    };
  }
  return null;
}

function markerEnd(content: PaneContent, start: number, marker: string): number | null {
  let text = rowText(content[start]).trimStart();
  let row = start;
  while (text.length < marker.length) {
    // Only a row filled to its edge can have wrapped into the next one.
    const filled = text.length > 0 && text === text.trimEnd() && marker.startsWith(text);
    if (!filled || row + 1 >= content.length) return null;
    row += 1;
    text += rowText(content[row]);
  }
  if (!text.startsWith(marker) || text.slice(marker.length).trim() !== '') return null;
  return row;
}
