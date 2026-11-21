/**
 * Which presses on the status bar are the desktop window's title bar: they
 * move the window (and a double press zooms it). See StatusBar.tsx.
 */

/** Interactive chrome inside the bar — clicks on these never drag or zoom the window. */
const CONTROLS =
  'button, [role="tab"], .tab-add, .app-menu-button, .sidebar-toggle, .sidebar-title';

/**
 * A lone tab is a title, not a control: with nothing to switch to, pressing on
 * it should move the window like the header around it. Its buttons (the `+`
 * beside it) stay controls.
 */
const isControl = (target: Element) => {
  if (target.closest('.tab-list-single .tab-name') && !target.closest('button')) return false;
  return target.closest(CONTROLS) !== null;
};

/**
 * Whether a press the bar was handed moves the window. React hands the bar
 * the presses of everything it renders, portals included: the app menu and
 * its submenus are drawn into the page's body (floating/MenuPanel.tsx), and a
 * press on one of their items moved the window, which then followed the
 * pointer. Only a press on the bar itself, off its controls, does.
 */
export function pressMovesWindow(bar: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !bar.contains(target)) return false;
  return !isControl(target);
}
