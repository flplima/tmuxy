/**
 * Layout Constants
 *
 * Shared constants for pane layout calculations and UI spacing.
 *
 * Key invariant for vertical axis:
 *   PANE_HEADER_HEIGHT + 2 * PANE_INSET_Y = CHAR_HEIGHT
 *   so each pane's overhead consumes exactly 1 character row.
 *
 * Key invariant for horizontal axis:
 *   paneInsetX = charWidth / 2  (computed at runtime from measured charWidth)
 *   so adjacent pane boxes tile seamlessly with the tmux divider column consumed
 *   equally by both sides. Terminal content padding = paneInsetX - PANE_BORDER.
 */

// Character dimensions (approximate for monospace font; charWidth is measured at runtime)
// Font size: 15px with line-height 1.4 = 21px char height
export const CHAR_WIDTH = 9.6;
export const CHAR_HEIGHT = 21;

// Minimum padding around the pane container (32px on all sides)
export const CONTAINER_PADDING = 32;

// Pane header height = exactly 1 char height so header consumes exactly 1 terminal row
export const PANE_HEADER_HEIGHT = CHAR_HEIGHT;

// Pane border: 1px solid around each pane-layout-item
export const PANE_BORDER = 1;

// Vertical inset: 0 since header = char height
export const PANE_INSET_Y = 0;

// Horizontal inset computed at runtime: charWidth / 2
// Exported helper to derive it from measured charWidth.
export function paneInsetX(charWidth: number): number {
  return charWidth / 2;
}

// Horizontal padding inside .pane-content so terminal chars align to the char grid.
// padding = paneInsetX - border
export function paneContentPaddingH(charWidth: number): number {
  return charWidth / 2 - PANE_BORDER;
}

// Status bars
export const STATUS_BAR_HEIGHT = 37; // 36px height + 1px border
export const TMUX_STATUS_BAR_HEIGHT = 29; // 21px line-height + 4px padding top/bottom

