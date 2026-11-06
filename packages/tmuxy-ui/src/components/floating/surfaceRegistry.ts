/**
 * One floating surface at a time: opening a top-level surface (a preview, a
 * context menu, the app menu) dismisses whichever top-level surface was open; a
 * surface opened as a child of the open one (a submenu) leaves its parent alone.
 *
 * Module state rather than a React context: the strip's preview and the status
 * line's app menu share no ancestor but the app root.
 */

interface OpenSurface {
  id: string;
  /** Called when a peer opens. Must put this surface away. */
  dismiss: () => void;
}

let current: OpenSurface | null = null;

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
    current = null;
    previous.dismiss();
  }
  current = { id, dismiss };

  return () => {
    if (current?.id === id) current = null;
  };
}

/** Drop all state. Tests only — module state outlives a component tree. */
export function resetSurfaceRegistry(): void {
  current = null;
}
