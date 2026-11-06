/**
 * Panes in the order the eye reads a tab's grid: top to bottom, and left to
 * right along a row. tmux's own order is the order panes were created in,
 * which a split, a swap or a move leaves unrelated to where they are on screen.
 */
export function inGridOrder<P extends { x: number; y: number }>(panes: readonly P[]): P[] {
  return [...panes].sort((a, b) => a.y - b.y || a.x - b.x);
}
