/**
 * Layout Constants
 *
 * Shared constants for pane layout calculations and UI spacing.
 * Mosaic layout: panes tile edge-to-edge with no spacing.
 *
 * Key invariant for the vertical axis: a pane's header is exactly
 * CHAR_HEIGHT tall, so it consumes exactly one character row.
 */

export const CHAR_HEIGHT = 24;

/**
 * The pane container's padding on a phone: a few pixels each side so the
 * grid's outer borders — drawn half a cell outside the panes — stay on
 * screen, and the same below. A copy of styles/phone.css's
 * `--pane-container-padding-*`, held to it by components/__tests__/cssMirrors.test.ts.
 */
export const PHONE_CONTAINER_PADDING = 4;

// Padding of .pane-container: a copy of `--pane-container-padding-*`
// (styles.css), held to it by components/__tests__/cssMirrors.test.ts. The grid
// is centred in the content box, so the visible margin is the padding plus
// half the leftover of a cell.
export const CONTAINER_PADDING_X = 12;
export const CONTAINER_PADDING_BOTTOM = 4;

/**
 * The side padding the pane container has: a few pixels in the phone layout,
 * enough for the grid's outer borders (styles/phone.css).
 */
export function containerPaddingX(phone: boolean): number {
  return phone ? PHONE_CONTAINER_PADDING : CONTAINER_PADDING_X;
}

/* How long a closed pane's absence keeps the shift lifecycle open, so the
   survivors GROW into the space it left. The pane itself is not drawn for any
   of it: closing is instant, and what animates is the space opening up. */
export const PANE_LEAVE_MS = 160;
// Opacity the entering pane starts from before fading in to full.
export const PANE_ENTER_FROM_OPACITY = 0.4;

// Status bars
export const STATUS_BAR_HEIGHT = 37; // 36px height + 1px border
export const TMUX_STATUS_BAR_HEIGHT = 32; // 24px line-height + 8px padding (4px top/bottom)
