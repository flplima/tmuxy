/**
 * Machine Constants
 *
 * Shared constants used across state machines.
 */

import { CHAR_HEIGHT } from '../constants/layout';

/** Default character width for grid calculations (px) */
export const DEFAULT_CHAR_WIDTH = 9.6;

/** Default character height for grid calculations (px). CHAR_HEIGHT must
 * match `--line-height-terminal` in `styles.css`, or PaneLayout's pixel math
 * diverges from the rendered row height. */
export const DEFAULT_CHAR_HEIGHT = CHAR_HEIGHT;

/** Default terminal columns */
export const DEFAULT_COLS = 80;

/** Default terminal rows */
export const DEFAULT_ROWS = 24;

/** Default session name */
export const DEFAULT_SESSION_NAME = 'tmuxy';

/**
 * How long a dropped channel stays silent before the user is told: a brief
 * drop that reconnects inside this window (a Wi-Fi roam, a sleep/wake) is
 * never seen. Past it, a notice in the snackbar corner, never an overlay —
 * the panes stay in view and usable.
 */
export const RECONNECT_NOTICE_DELAY_MS = 2000;

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
 * Bounds a sidebar column may be dragged between, in columns. Mirror
 * `sidebar_dock::MIN_COLS` / `MAX_COLS` in `tmuxy-core/src/constants.rs`, which
 * clamps the same way — so a drag can never preview a width the backend would
 * then refuse to size the pane to.
 */
export const SIDEBAR_MIN_COLS = 16;
export const SIDEBAR_MAX_COLS = 120;
