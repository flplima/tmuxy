/**
 * Keys replayed into the app out of a preview's sandboxed frame: the
 * `HtmlPreview` widget tags each synthetic KeyboardEvent it dispatches, and
 * the keyboard actor asks, so a page can only reach the commands a replayed
 * key is allowed (`PREVIEW_SAFE_ROOT_COMMAND`).
 */

const replayedPreviewKeys = new WeakSet<KeyboardEvent>();

export function markReplayedPreviewKey<T extends KeyboardEvent>(event: T): T {
  replayedPreviewKeys.add(event);
  return event;
}

export function isReplayedPreviewKey(event: KeyboardEvent): boolean {
  return replayedPreviewKeys.has(event);
}
