/**
 * One link, several anchors: a URL that wraps is drawn as one `<a>` per row,
 * and `:hover` lights only the row under the pointer. Hovering any fragment
 * marks every anchor in the same grid that opens the same URL, so the whole
 * address reads as one link.
 */

export const LINK_HOT_CLASS = 'terminal-link-hot';

export function setLinkHot(target: EventTarget | null, hot: boolean): void {
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  const grid = anchor?.closest('.terminal-content');
  if (!anchor || !grid) return;
  const href = anchor.getAttribute('href');
  for (const a of grid.querySelectorAll('a[href]')) {
    if (a.getAttribute('href') === href) a.classList.toggle(LINK_HOT_CLASS, hot);
  }
}
