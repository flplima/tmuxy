/**
 * When Tab walks the app's chrome and when it is the terminal's.
 *
 * Tab belongs to the terminal while a pane holds the keyboard. On one of the
 * app's own controls (a header button, a tab, the tree, a menu item) it moves
 * the focus on, as on any page, but only when the focus got there by the
 * keyboard or by script. A click leaves the focus on the button it pressed,
 * and the Tab typed next is meant for the shell's completion, not for the
 * page.
 */

const CHROME_CONTROL =
  'button, a[href], [role="tab"], [role="treeitem"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';

/**
 * A pane's own surface: the wrapper a tiled pane or a widget draws in, and a
 * float's container. Focusable for the pointer, and the terminal's. The tree's
 * pane rows carry a pane id too, but they are chrome.
 */
export const PANE_SURFACE = '.pane-wrapper[data-pane-id], .float-container[data-pane-id]';

let pointerFocused: EventTarget | null = null;

/** Every focus move, and whether a pointer press made it. */
export function noteFocus(target: EventTarget | null, byPointer: boolean): void {
  pointerFocused = byPointer ? target : null;
}

/** Whether Tab on `target` moves the browser's focus rather than reaching a pane. */
export function tabWalksChrome(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.matches !== 'function') return false;
  if (element === document.body || element === pointerFocused) return false;
  if (element.matches(PANE_SURFACE)) return false;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return false;
  return element.matches(CHROME_CONTROL);
}
