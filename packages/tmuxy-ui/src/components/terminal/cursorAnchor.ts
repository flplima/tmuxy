/**
 * The `Cursor` element of the pane holding the keyboard, which `SmoothCursor`
 * measures and glides to. It re-registers on every commit (its ref callback is
 * recreated per render), which is how the overlay learns about a move.
 */

let anchor: HTMLElement | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump() {
  version += 1;
  for (const listener of listeners) listener();
}

export function attachCursorAnchor(el: HTMLElement): () => void {
  anchor = el;
  bump();
  return () => {
    if (anchor === el) anchor = null;
    bump();
  };
}

/**
 * For DOM moves no pane render announces (the Tab Overview dragging the
 * current tab's card).
 */
export function nudgeCursorAnchor(): void {
  bump();
}

export function subscribeCursorAnchor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getCursorAnchorVersion = () => version;
export const getCursorAnchor = () => anchor;
