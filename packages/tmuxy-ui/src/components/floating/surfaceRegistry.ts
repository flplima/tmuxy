/**
 * One floating surface at a time.
 *
 * A preview, a context menu and the app menu are all cards that float over the
 * grid, and each used to own its own open/closed flag. Nothing knew about the
 * others, so right-clicking a tab you were hovering drew the menu ON TOP of its
 * preview, and opening the app menu left a preview hanging behind it. Every
 * pairing needed its own "and also close that one" line, which is a list that is
 * never finished — the bug comes back with the next surface somebody adds.
 *
 * So dismissal lives here instead of in each surface: opening a TOP-LEVEL
 * surface dismisses whichever top-level surface was open. A surface opened as a
 * CHILD of the open one (a submenu) is a different thing — it belongs to its
 * parent and leaves it alone.
 *
 * Module state rather than a React context on purpose: a surface has to be able
 * to dismiss a peer that lives in another part of the tree (the strip's preview
 * and the status line's app menu share no ancestor but the app root), and a
 * registry threaded through context would have to be mounted above both to do
 * it.
 */

/** What an open surface tells the registry so it can be closed from outside. */
interface OpenSurface {
  id: string;
  /** Called when a peer opens. Must put this surface away. */
  dismiss: () => void;
}

let current: OpenSurface | null = null;

/** Subscribers to "what is open now", for anything that renders differently
 * while a surface is up (the tab strip dims its hover affordance). */
const listeners = new Set<(id: string | null) => void>();

function notify() {
  const id = current?.id ?? null;
  for (const listener of listeners) listener(id);
}

/**
 * Claim the floating layer for `id`, dismissing whatever held it.
 *
 * Returns a release function. Calling it when this surface no longer holds the
 * layer does nothing, which is what makes it safe to call from an effect
 * cleanup that runs after a peer has already taken over.
 */
export function openSurface(id: string, dismiss: () => void): () => void {
  if (current && current.id !== id) {
    const previous = current;
    // Cleared BEFORE dismissing: a surface's dismiss may synchronously run its
    // own cleanup, and that cleanup must not see itself as current and clear
    // the entry this call is about to write.
    current = null;
    previous.dismiss();
  }
  current = { id, dismiss };
  notify();

  return () => {
    if (current?.id === id) {
      current = null;
      notify();
    }
  };
}

/** Put away whatever floating surface is open. Safe when none is. */
export function dismissOpenSurface(): void {
  if (!current) return;
  const open = current;
  current = null;
  open.dismiss();
  notify();
}

/** The id of the open top-level surface, or null. */
export function openSurfaceId(): string | null {
  return current?.id ?? null;
}

/** Subscribe to changes in which surface is open. Returns an unsubscribe. */
export function subscribeSurface(listener: (id: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop all state. Tests only — module state outlives a component tree. */
export function resetSurfaceRegistry(): void {
  current = null;
  listeners.clear();
}
