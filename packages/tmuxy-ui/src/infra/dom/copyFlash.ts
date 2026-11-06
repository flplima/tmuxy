/**
 * The blink that says "copied".
 *
 * A copy gives no feedback of its own: the clipboard is invisible, and in copy
 * mode the selection used to vanish with the mode. So whatever is copied
 * flashes briefly where it sits on screen, in both selection models:
 *
 * - copy mode paints its own selection, so the flash is a state it renders
 *   (`CopyModeState.copiedAt` → `[data-copied]` on the scrollback, see
 *   styles.css) and the view closes when the flash is over;
 * - a selection the browser owns lives in DOM ranges, so the flash is laid
 *   over the range's rectangles here, as fixed boxes that remove themselves.
 *
 * Both use the same keyframes and the same duration, and both follow the
 * animations switch: with animations off the highlight holds steady for the
 * same time instead of blinking.
 */

/** How long the copied text blinks before copy mode closes. */
export const COPY_FLASH_MS = 450;

/** Flash the rectangles a copied browser selection covers. */
export function flashCopiedRange(range: Range | null | undefined): void {
  if (!range || typeof document === 'undefined') return;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return;
  const host = document.querySelector('.app-container') ?? document.body;
  const boxes = rects.map((r) => {
    const box = document.createElement('div');
    box.className = 'copy-flash';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    host.appendChild(box);
    return box;
  });
  window.setTimeout(() => boxes.forEach((box) => box.remove()), COPY_FLASH_MS);
}
