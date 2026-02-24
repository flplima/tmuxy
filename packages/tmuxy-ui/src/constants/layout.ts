/**
 * Layout Constants
 *
 * Shared constants for pane layout calculations and UI spacing.
 * Mosaic layout: panes tile edge-to-edge with no spacing.
 *
 * Key invariant for vertical axis:
 *   PANE_HEADER_HEIGHT = CHAR_HEIGHT
 *   so each pane's header consumes exactly 1 character row.
 */

export const CHAR_HEIGHT = 21;

// Minimum padding around the pane container
export const CONTAINER_PADDING = 0;

// Pane header height = exactly 1 char height so header consumes exactly 1 terminal row
export const PANE_HEADER_HEIGHT = CHAR_HEIGHT;

// Pane border: 1px solid around each pane-layout-item
export const PANE_BORDER = 1;

// Vertical inset: 0 since header = char height
export const PANE_INSET_Y = 0;

// Horizontal inset: half charWidth to cover tmux divider column gap
export function paneInsetX(charWidth: number): number {
  return Math.round(charWidth / 2);
}

// Horizontal padding inside .pane-content to align terminal chars
export function paneContentPaddingH(charWidth: number): number {
  return Math.round(charWidth / 2) - PANE_BORDER;
}

// Status bars
export const STATUS_BAR_HEIGHT = 37; // 36px height + 1px border
export const TMUX_STATUS_BAR_HEIGHT = 29; // 21px line-height + 4px padding top/bottom
