import { CHAR_HEIGHT } from '../constants/layout';
import { SIDEBAR_DOCK } from '../domain/tmuxyConstants.gen';

export const DEFAULT_CHAR_WIDTH = 9.6;

/**
 * CHAR_HEIGHT must match `--line-height-terminal` in `styles.css`, or
 * PaneLayout's pixel math diverges from the rendered row height.
 */
export const DEFAULT_CHAR_HEIGHT = CHAR_HEIGHT;

export const DEFAULT_COLS = 80;

export const DEFAULT_ROWS = 24;

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
 * wraps their content at: the backend's `sidebar_dock`, which it resizes each
 * `sidebar-*`-typed window to, generated into `tmuxyConstants.gen.ts`.
 *
 * The pixel width derives from cols × charWidth, so a column stays in lockstep
 * with the pane grid across font-size changes.
 */
export const LEFT_SIDEBAR_COLS = SIDEBAR_DOCK.leftCols;

/** Width of the right sidebar column (the pinned terminal), in columns. */
export const RIGHT_SIDEBAR_COLS = SIDEBAR_DOCK.rightCols;

/**
 * Bounds a sidebar column may be dragged between, in columns: the backend's,
 * which clamps the same way — so a drag can never preview a width the backend
 * would then refuse to size the pane to.
 */
export const SIDEBAR_MIN_COLS = SIDEBAR_DOCK.minCols;
export const SIDEBAR_MAX_COLS = SIDEBAR_DOCK.maxCols;
