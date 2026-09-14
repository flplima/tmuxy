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
 * newline, trailing padding dropped.
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
  while (parts.length > 1 && parts[parts.length - 1].collapsed) parts.pop();
  while (parts.length > 1 && parts[0].collapsed) parts.shift();
  return parts
    .map((part) => (part.cloneContents().textContent ?? '').replace(/\s+$/, ''))
    .join('\n');
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
 * Select the word under a viewport point.
 *
 * For a right-click on unselected text: a menu offering "Copy" with nothing
 * selected is useless, and every browser and terminal picks the word first.
 * `Selection.modify` does the word-boundary work, so this stays out of the
 * business of deciding what a word is in a given script.
 *
 * Returns false when the point has no text (a blank region of the grid), or
 * when the engine offers neither caret-from-point API.
 */
export function selectWordAtPoint(clientX: number, clientY: number): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection) return false;

  const range = caretRangeAt(clientX, clientY);
  if (!range) return false;

  selection.removeAllRanges();
  selection.addRange(range);

  // `modify` is unimplemented in jsdom and absent on older engines; a caret
  // with no expansion selects nothing, so report that rather than pretend.
  const selectionWithModify = selection as Selection & {
    modify?: (alter: string, direction: string, granularity: string) => void;
  };
  if (typeof selectionWithModify.modify !== 'function') return false;

  selectionWithModify.modify('move', 'backward', 'word');
  selectionWithModify.modify('extend', 'forward', 'word');
  return selection.toString().trim().length > 0;
}

/** A collapsed range at a viewport point, across the two engine APIs. */
function caretRangeAt(clientX: number, clientY: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };

  // WebKit and Blink — the engines tmuxy ships against.
  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(clientX, clientY);
  }
  // Gecko's standardised equivalent.
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return null;
}
