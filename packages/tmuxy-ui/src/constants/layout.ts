// A pane's header is exactly CHAR_HEIGHT tall: it takes one character row.
export const CHAR_HEIGHT = 24;

/**
 * The pane container's padding on a phone, enough to keep the grid's outer
 * borders (drawn half a cell outside the panes) on screen. A copy of
 * styles/phone.css's `--pane-container-padding-*`, held to it by
 * components/__tests__/cssMirrors.test.ts.
 */
export const PHONE_CONTAINER_PADDING = 4;

// Padding of .pane-container: a copy of `--pane-container-padding-*`
// (styles.css), held to it by components/__tests__/cssMirrors.test.ts. The grid
// is centred in the content box, so the visible margin is the padding plus
// half the leftover of a cell.
export const CONTAINER_PADDING_X = 12;
export const CONTAINER_PADDING_BOTTOM = 4;

export function containerPaddingX(phone: boolean): number {
  return phone ? PHONE_CONTAINER_PADDING : CONTAINER_PADDING_X;
}

// How long the survivors take to grow into a closed pane's space. Closing
// itself is instant: what animates is the space opening up.
export const PANE_LEAVE_MS = 160;
export const PANE_ENTER_FROM_OPACITY = 0.4;

export const STATUS_BAR_HEIGHT = 37; // 36px height + 1px border
export const TMUX_STATUS_BAR_HEIGHT = 32; // 24px line-height + 8px padding (4px top/bottom)
