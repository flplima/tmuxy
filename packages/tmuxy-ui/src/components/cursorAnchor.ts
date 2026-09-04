/**
 * Where the terminal cursor is on the page.
 *
 * The pane holding the keyboard renders a `Cursor` at its cursor cell; that
 * element is registered here as the ANCHOR, and `SmoothCursor` — the one
 * cursor the user actually sees — measures it and glides to it. Registering
 * on every commit (the ref callback below is recreated per render, so React
 * re-attaches it each time) is what lets the overlay learn about a move,
 * and the anchor going away (another pane took the keyboard, the pane was
 * closed) is what lets it fly to the next one.
 */

let anchor: HTMLElement | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Ref callback for the anchor element; returns the detach cleanup React calls. */
export function attachCursorAnchor(el: HTMLElement): () => void {
  anchor = el;
  bump();
  return () => {
    if (anchor === el) anchor = null;
    bump();
  };
}

export function subscribeCursorAnchor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getCursorAnchorVersion = () => version;
export const getCursorAnchor = () => anchor;
