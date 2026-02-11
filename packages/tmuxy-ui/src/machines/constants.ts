/**
 * Machine Constants
 *
 * Shared constants used across state machines.
 */

/** Timeout for prefix key wait state (ms) */
export const PREFIX_TIMEOUT = 2000;

/** Timeout for commit states before falling back to idle (ms) */
export const COMMIT_TIMEOUT = 5000;

/** Default character width for grid calculations (px) */
export const DEFAULT_CHAR_WIDTH = 9.6;

/** Default character height for grid calculations (px) */
export const DEFAULT_CHAR_HEIGHT = 20;

/** Default terminal columns */
export const DEFAULT_COLS = 80;

/** Default terminal rows */
export const DEFAULT_ROWS = 24;

/** Default session name */
export const DEFAULT_SESSION_NAME = 'tmuxy';

/** Duration for pane enter/exit animations (ms) */
export const PANE_ANIMATION_DURATION = 125;

/** Animation speed for position-based animations (pixels per millisecond) */
export const PANE_ANIMATION_SPEED = 3;

/** Minimum animation duration (ms) - prevents too-fast animations */
export const PANE_ANIMATION_MIN_DURATION = 50;

/** Maximum animation duration (ms) - prevents too-slow animations */
export const PANE_ANIMATION_MAX_DURATION = 200;

/**
 * Calculate animation duration based on distance traveled.
 * Uses fixed speed so short distances are fast and long distances take proportionally longer.
 */
export function calculateAnimationDuration(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): number {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  const duration = distance / PANE_ANIMATION_SPEED;
  return Math.max(PANE_ANIMATION_MIN_DURATION, Math.min(PANE_ANIMATION_MAX_DURATION, duration));
}

/** list-panes format string matching the backend parser (state.rs parse_list_panes_line) */
export const LIST_PANES_REFRESH_CMD = "list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id},#{T:pane-border-format},#{alternate_on},#{mouse_any_flag},#{@tmuxy_pane_group_id},#{@tmuxy_pane_group_index}'";
