/**
 * Which cursor moves are scene changes: the picture under the cursor is
 * replaced, so `SmoothCursor` draws the cursor at its new place instead of
 * gliding there.
 */

/** Where the keyboard is, as the snap rule needs it: tab, pane, the pane's group. */
export interface Scene {
  /** The active TAB; null while tmux's current window is a chrome window (dock, sidebar, float). */
  window: string | null;
  pane: string | null;
  group: string | null;
}

/**
 * Whether going from `prev` to `next` swaps the picture under the cursor
 * rather than moving the cursor within it: another tab, or another member of
 * the same pane group shown in its place. Moving between panes of one tab —
 * a group member included, to or from a neighbour — is a move, and glides.
 * So is moving into the dock or a sidebar: tmux makes their window current,
 * but the tab on screen stays, so a step through a chrome window (null) is
 * not a tab change.
 */
export function isSceneChange(prev: Scene | null, next: Scene): boolean {
  if (!prev) return false;
  if (prev.window !== null && next.window !== null && prev.window !== next.window) return true;
  return prev.pane !== next.pane && prev.group !== null && prev.group === next.group;
}

/** The scene as one string, so a selector can return it (and re-render only on change). */
export const sceneKey = (s: Scene) => `${s.window ?? ''}|${s.pane ?? ''}|${s.group ?? ''}`;
export const parseScene = (key: string): Scene => {
  const [window, pane, group] = key.split('|');
  return { window: window || null, pane: pane || null, group: group || null };
};
