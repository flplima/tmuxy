/**
 * The DOM contract of the pane grid: the class names the terminal renderer
 * and the pane chrome draw, and the selectors everything else finds them by
 * (the selection, links, the pointer hooks, the keyboard and gesture actors).
 * The stylesheets spell the same names (`styles/terminal.css`,
 * `styles/pane-layout.css`).
 */

/** One rendered row of a pane. */
export const TERMINAL_LINE = 'terminal-line';
/** The grid of rows, live or scrollback. */
export const TERMINAL_CONTENT = 'terminal-content';
/** A grid whose text the browser may select. */
export const TERMINAL_SELECTABLE = 'terminal-selectable';
/** A row the browser's selection runs past. */
export const TERMINAL_LINE_SELECTED = 'terminal-line-selected-on';
/** Every anchor of a URL while one of its fragments is hovered. */
export const TERMINAL_LINK_HOT = 'terminal-link-hot';
/** The cursor's anchor cell; the cursor itself is drawn over it. */
export const TERMINAL_CURSOR = 'terminal-cursor';
/** A pane's header strip: its tabs and buttons, not the terminal. */
export const PANE_HEADER = 'pane-header';

/** `.name`, for `closest` and `querySelector`. */
export const dot = (className: string): string => `.${className}`;

/**
 * A pane's own surface: the wrapper a tiled pane or a widget draws in, and a
 * float's container. Focusable for the pointer, and the terminal's. The tree's
 * pane rows carry a pane id too, but they are chrome.
 */
export const PANE_SURFACE = '.pane-wrapper[data-pane-id], .float-container[data-pane-id]';

/** A tiled pane's box in the grid (not a float), by its pane id. */
export const TILED_PANE = '.pane-layout-item[data-pane-id]';
