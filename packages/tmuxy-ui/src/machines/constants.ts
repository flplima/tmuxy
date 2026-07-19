/**
 * Machine Constants
 *
 * Shared constants used across state machines.
 */

/** Default character width for grid calculations (px) */
export const DEFAULT_CHAR_WIDTH = 9.6;

/** Default character height for grid calculations (px). Must match
 * CHAR_HEIGHT in `constants/layout.ts` and `--line-height-terminal` in
 * `styles.css`, or PaneLayout's pixel math diverges from the rendered
 * row height (the layout calculates with this value while the CSS
 * renders rows at the stylesheet's height). */
export const DEFAULT_CHAR_HEIGHT = 24;

/** Default terminal columns */
export const DEFAULT_COLS = 80;

/** Default terminal rows */
export const DEFAULT_ROWS = 24;

/** Default session name */
export const DEFAULT_SESSION_NAME = 'tmuxy';

/**
 * Width of the left sidebar drawer, in columns. The drawer's pixel width derives
 * from this × charWidth (and the main pane area's left inset matches), so they
 * stay in lockstep across font-size changes.
 */
export const SIDEBAR_COLS = 30;
