export interface Scene {
  /** The active TAB; null while tmux's current window is a chrome window (dock, sidebar, float). */
  window: string | null;
  pane: string | null;
  group: string | null;
}

/**
 * Whether the picture under the cursor is swapped (another tab, or another
 * member of the same pane group in its place), so `SmoothCursor` does not
 * glide. Moving into the dock or a sidebar makes their window tmux's current
 * one, but the tab on screen stays: a chrome window (null) is no tab change.
 */
export function isSceneChange(prev: Scene | null, next: Scene): boolean {
  if (!prev) return false;
  if (prev.window !== null && next.window !== null && prev.window !== next.window) return true;
  return prev.pane !== next.pane && prev.group !== null && prev.group === next.group;
}

/** A string, so a selector re-renders only on change. */
export const sceneKey = (s: Scene) => `${s.window ?? ''}|${s.pane ?? ''}|${s.group ?? ''}`;
export const parseScene = (key: string): Scene => {
  const [window, pane, group] = key.split('|');
  return { window: window || null, pane: pane || null, group: group || null };
};
