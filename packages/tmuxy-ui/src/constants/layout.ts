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

export const CHAR_HEIGHT = 24;

// Minimum padding around the pane container
export const CONTAINER_PADDING = 8;

// Pane header height = exactly 1 char height so header consumes exactly 1 terminal row
export const PANE_HEADER_HEIGHT = CHAR_HEIGHT;

// Vertical inset: 0 since header = char height
export const PANE_INSET_Y = 0;

// Horizontal inset: half charWidth to cover tmux divider column gap
export function paneInsetX(charWidth: number): number {
  return Math.round(charWidth / 2);
}

/**
 * A pane's pixel rectangle in the layout.
 *
 * Mosaic invariant — every pane occupies one extra cell in each axis beyond
 * its tmux content size; that extra cell is the border, split into two halves
 * shared with the neighbour on each side (or with the grid edge):
 *
 *   width  = charWidth  * (pane.width  + 1)
 *   height = charHeight * (pane.height + 1)   // the +1 row is the header
 *
 * Each pane is shifted half a cell left (for the shared vertical border) and
 * one full cell up (the header row, which under `pane-border-status top` lives
 * in tmux's separator row at y-1). Adjacent panes' rectangles therefore meet
 * exactly — left.right === right.left and top.bottom === bottom.top — so their
 * 1px outlines coincide and the grid reads as a single connected frame with no
 * gaps between panes.
 *
 * The topmost pane can report y=0 (no separator row above it — some tiled
 * layouts do this). Such a pane has no header row to hoist, so the vertical
 * shift is clamped to 0; otherwise it would render a full cell above the grid.
 */
export interface PaneBoxInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computePaneBox(
  pane: PaneBoxInput,
  charWidth: number,
  charHeight: number,
  offsetX = 0,
  offsetY = 0,
): PaneBox {
  // Header row only exists when there's a separator above the pane (y > 0).
  const headerRows = pane.y > 0 ? 1 : 0;
  return {
    left: offsetX + (pane.x - 0.5) * charWidth,
    top: offsetY + (pane.y - headerRows) * charHeight,
    width: (pane.width + 1) * charWidth,
    height: (pane.height + headerRows) * charHeight,
  };
}

/* Pane enter/leave lifecycle (split/kill morph animations).
   Durations must stay in sync with --transition-pane-enter /
   --transition-pane-leave (styles.css) — JS timers hold the lifecycle
   classes slightly past the CSS transition end. */
export const PANE_ENTER_MS = 180;
export const PANE_LEAVE_MS = 160;
// Opacity the entering pane starts from before fading in to full.
export const PANE_ENTER_FROM_OPACITY = 0.4;

/** A pane is collapsed in a stack when tmux has shrunk it to a single row. */
export function isCollapsedPane(pane: { height: number }): boolean {
  return pane.height <= 1;
}

// Status bars
export const STATUS_BAR_HEIGHT = 37; // 36px height + 1px border
export const TMUX_STATUS_BAR_HEIGHT = 32; // 24px line-height + 8px padding (4px top/bottom)
