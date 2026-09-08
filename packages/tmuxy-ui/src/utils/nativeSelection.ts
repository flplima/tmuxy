/**
 * The browser's own text selection, as terminal panes use it.
 *
 * Outside tmux's copy mode a pane's text is selected by the browser rather
 * than by the client's cell engine — that is what makes dragging,
 * double-clicking and Cmd+C behave the way they do in any other terminal.
 * These are the two things the app needs that `window.getSelection()` does not
 * hand over directly.
 */

/** The selected text, or '' when nothing is selected. */
export function readNativeSelection(): string {
  if (typeof window === 'undefined') return '';
  return window.getSelection()?.toString() ?? '';
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
