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
 * Width of the left sidebar column (the tab/pane tree widget), in columns.
 *
 * Both sidebars are REAL tmux panes, so these numbers are also the width tmux
 * wraps their content at: they must match `sidebar_dock::LEFT_COLS` /
 * `RIGHT_COLS` in `tmuxy-core/src/constants.rs`, which is what the backend
 * resizes each `sidebar-*`-typed window to. If the two sides disagree, the
 * pane wraps at a width the UI never draws.
 *
 * The pixel width derives from cols × charWidth, so a column stays in lockstep
 * with the pane grid across font-size changes.
 */
export const LEFT_SIDEBAR_COLS = 30;

/** Width of the right sidebar column (the pinned terminal), in columns. */
export const RIGHT_SIDEBAR_COLS = 35;

/**
 * Below this many columns of terminal content left for the tab after a sidebar
 * takes its width, the sidebar stops being a flex sibling and overlays the
 * panes (and the tab strip) with a backdrop instead — shrinking the grid any
 * further leaves nothing usable behind it. Only one column may overlay at a
 * time.
 */
export const SIDEBAR_OVERLAY_MIN_COLS = 60;

/**
 * Bounds a sidebar column may be dragged between, in columns. Mirror
 * `sidebar_dock::MIN_COLS` / `MAX_COLS` in `tmuxy-core/src/constants.rs`, which
 * clamps the same way — so a drag can never preview a width the backend would
 * then refuse to size the pane to.
 */
/**
 * How long a sidebar column takes to slide open or shut. Mirrors
 * `--transition-sidebar` in styles.css; the settle event fires a little after
 * it so the column's transition classes come off once it has stopped moving.
 */
export const SIDEBAR_TRANSITION_MS = 200;
export const SIDEBAR_MOTION_SETTLE_MS = SIDEBAR_TRANSITION_MS + 50;

export const SIDEBAR_MIN_COLS = 16;
export const SIDEBAR_MAX_COLS = 120;
