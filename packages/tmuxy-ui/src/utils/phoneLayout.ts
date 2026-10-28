/**
 * The phone layout: on a narrow window or a coarse pointer the app is a tab
 * strip, the whole 80 × 25 terminal, a key row under it and the tab/pane tree
 * below that, with no bottom bar of its own. Held sideways (landscape), the
 * terminal takes the right of the screen at the height that fits its 25 rows,
 * and the strip, the keys and the tree stack in the column left of it.
 *
 * The pty is never sized to the phone. The client asks for the classic 80 × 24
 * window and shrinks the cell until 80 columns span the screen, a few pixels
 * of padding each side, keeping the terminal's row ratio so a pinch zoom
 * reads true. The status line under it and the rest of the chrome keep their
 * own size.
 *
 * What a finger does on the terminal is hooks/usePaneTouch.ts; the key row,
 * the zoom and the bottom view (the tree, or the pinned terminal a sideways
 * swipe flips it to) are App.tsx and the `phone` state slice.
 *
 * Pure: no React, no machine.
 */

import { CHAR_HEIGHT, PHONE_CONTAINER_PADDING } from '../constants/layout';
import { DEFAULT_FONT_SIZE } from './fontSizeManager';

/** When the app takes the phone layout. */
export const PHONE_QUERY = '(pointer: coarse), (max-width: 600px)';

/**
 * The narrowest the column beside a landscape terminal gets: the key row's ten
 * keys and the tree have to stay usable, so a terminal that would leave less is
 * cut to the width instead of the height.
 */
export const PHONE_SIDE_MIN = 300;

/**
 * tmux's status line under the grid, in the chrome's type rather than a
 * terminal row: at the phone's cell a row is too short for the host and
 * session labels to be read, let alone tapped (styles mirror it).
 */
export const PHONE_STATUS_HEIGHT = 24;

/** The window a phone asks for; tmux's status line is drawn as a 25th row. */
export const PHONE_COLS = 80;
export const PHONE_ROWS = 24;

/** Row height over font size: 24px rows at the 15px terminal size. */
const ROW_RATIO = CHAR_HEIGHT / DEFAULT_FONT_SIZE;

export interface PhoneCell {
  /** Cell width in CSS px: the 80th part of the width, exactly. */
  cellWidth: number;
  /** letter-spacing that brings the font's advance up to `cellWidth`. */
  cellGap: number;
  /** The terminal font size, in px, that fits a cell. */
  fontSize: number;
  /** Row height in whole px. */
  rowHeight: number;
}

/**
 * The cell that fits 80 columns into `containerWidth`, exactly: the grid
 * spans the screen edge to edge.
 *
 * `advancePerPx` is the terminal font's advance per pixel of font size (about
 * 0.6 for FiraCode): the font is the largest whose advance fits the cell, and
 * the gap pads the rest. The cell is not floored to a device pixel: that
 * left up to a pixel per column unused, which on a 3x phone was a 26px band
 * of nothing beside the grid.
 */
export function phoneCell(containerWidth: number, advancePerPx: number): PhoneCell {
  const cellWidth = containerWidth / PHONE_COLS;
  const fontSize = Math.floor((cellWidth / advancePerPx) * 10) / 10;
  return {
    cellWidth,
    cellGap: cellWidth - fontSize * advancePerPx,
    fontSize,
    rowHeight: Math.round(fontSize * ROW_RATIO),
  };
}

/**
 * The cell for a phone held sideways: 24 rows of grid, the status line and
 * the container's padding fill `height`, and the 80 columns that gives are
 * as wide as they come — unless that would leave the column beside them
 * narrower than [`PHONE_SIDE_MIN`], when the cell is the one that fits the
 * width left.
 *
 * `height` is the screen's height with no keyboard up: the keyboard scrolls
 * the terminal (App's cursor follow), it does not shrink the type.
 */
export function phoneLandscapeCell(width: number, height: number, advancePerPx: number): PhoneCell {
  const rows = PHONE_ROWS;
  const chrome = PHONE_CONTAINER_PADDING + PHONE_STATUS_HEIGHT;
  let fontSize = Math.floor(((height - chrome) / rows / ROW_RATIO) * 10) / 10;
  while (fontSize > 1 && Math.round(fontSize * ROW_RATIO) * rows + chrome > height) {
    fontSize = Math.round((fontSize - 0.1) * 10) / 10;
  }
  const byHeight = fontSize * advancePerPx;
  const gridWidth = width - PHONE_SIDE_MIN - 2 * PHONE_CONTAINER_PADDING;
  const byWidth = Math.max(0, gridWidth) / PHONE_COLS;
  if (byWidth < byHeight) return phoneCell(gridWidth, advancePerPx);
  return {
    cellWidth: byHeight,
    cellGap: 0,
    fontSize,
    rowHeight: Math.round(fontSize * ROW_RATIO),
  };
}

/** The root's terminal font size in px: what a measurement on the body used. */
export function rootFontPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--tmuxy-font-size');
  const px = parseFloat(raw);
  return px > 0 ? px : DEFAULT_FONT_SIZE;
}

/** The media query, or null where there is no `matchMedia` (tests, old engines). */
export function phoneMediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY)
    : null;
}
