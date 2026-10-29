/**
 * The browser's own text selection, as terminal panes use it.
 *
 * Outside tmux's copy mode a pane's text is selected by the browser rather
 * than by the client's cell engine — that is what makes dragging,
 * double-clicking and Cmd+C behave the way they do in any other terminal.
 * These are the two things the app needs that `window.getSelection()` does not
 * hand over directly.
 */

/**
 * The selected text, or '' when nothing is selected — read the way a terminal
 * copies it: each screen row's selected text run together, rows joined by a
 * newline, trailing padding dropped, and rows that only SOFT-WRAPPED joined
 * with no break at all.
 *
 * `Selection.toString()` does not do that here. A row is a flex line of
 * styled spans, and flex items are block boxes, so the browser serializes a
 * line break between every pair of differently-styled runs: a coloured prompt
 * copied as `~/projects/tmuxy\n \nmain`. The text of each row is read from the
 * range instead. A selection outside the terminal is read as the browser
 * reads it.
 */
export function readNativeSelection(): string {
  if (typeof window === 'undefined') return '';
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  return terminalTextOf(selection.getRangeAt(0)) ?? selection.toString();
}

/** The terminal rows a range covers, as copied text; null outside a terminal. */
export function terminalTextOf(range: Range): string | null {
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const grid = start?.closest('.terminal-content');
  if (!grid) return null;
  const rows = [...grid.querySelectorAll('.terminal-line')].filter((row) =>
    range.intersectsNode(row),
  );
  if (rows.length === 0) return null;
  const parts = rows.map((row) => {
    const part = document.createRange();
    part.selectNodeContents(row);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
      part.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
      part.setEnd(range.endContainer, range.endOffset);
    }
    return part;
  });
  // A drag to the end of a row leaves the selection ending at the START of the
  // next one, which counts as touching it: that row contributes nothing but a
  // trailing newline. Rows only touched at an edge are dropped from the ends;
  // a blank row selected in between still keeps its line.
  while (parts.length > 1 && parts[parts.length - 1].collapsed) {
    parts.pop();
    rows.pop();
  }
  while (parts.length > 1 && parts[0].collapsed) {
    parts.shift();
    rows.shift();
  }

  // A row that filled the pane's full width has no logical line break after it
  // — the text simply ran on (`data-wrapped`, set by TerminalLine). Copying a
  // newline there is how a pasted path or command came back broken at whatever
  // width the pane happened to be, which is not what any other terminal does.
  // Its trailing spaces are content rather than padding, so they are kept too.
  return parts
    .map((part, index) => {
      // Only BETWEEN rows: the last row ends the selection, so whether it went
      // on to wrap says nothing about what was selected, and its padding is
      // trailing padding like any other row's.
      const soft = index < parts.length - 1 && rows[index]?.getAttribute('data-wrapped') === 'true';
      const text = part.cloneContents().textContent ?? '';
      return (soft ? text : text.replace(/\s+$/, '')) + (soft ? '' : '\n');
    })
    .join('')
    .replace(/\n$/, '');
}

/**
 * A copy of the selection's range, or null when nothing is selected — taken
 * at the moment it matters, since focus moving later (to a menu, say)
 * collapses the live selection on WebKit.
 */
export function cloneNativeSelectionRange(): Range | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  return selection.getRangeAt(0).cloneRange();
}

/**
 * The page's selection while it lies over terminal text: the range and the
 * text a terminal copies from it; null when nothing is selected or the
 * selection is elsewhere (a form field, the chrome).
 */
export function terminalSelection(): { range: Range; text: string } | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const text = terminalTextOf(range);
  return text === null || text.length === 0 ? null : { range, text };
}

/** Collapse the page's selection: the highlight goes, the clipboard keeps what it got. */
export function clearNativeSelection(): void {
  if (typeof window === 'undefined') return;
  window.getSelection()?.removeAllRanges();
}
