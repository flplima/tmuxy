/**
 * tmux's own pane order is creation order, which a split, a swap or a move
 * leaves unrelated to where panes are on screen.
 */
export function inGridOrder<P extends { x: number; y: number }>(panes: readonly P[]): P[] {
  return [...panes].sort((a, b) => a.y - b.y || a.x - b.x);
}
