/**
 * The phone layout: on a narrow window or a coarse pointer the app is the
 * whole 80 × 25 terminal on top, a key row under it and the tab/pane tree
 * below that. No tab strip, no bottom bar of its own.
 *
 * The pty is never sized to the phone. The client asks for the classic 80 × 24
 * window (tmux's status line is the 25th row, drawn under it) and shrinks the
 * cell until 80 columns span the screen edge to edge, keeping the terminal's
 * row ratio so the browser's pinch zoom reads true. The chrome keeps its own
 * size.
 *
 * Pure: no React, no machine.
 */

import { CHAR_HEIGHT } from '../constants/layout';
import { DEFAULT_FONT_SIZE } from './fontSizeManager';

/** When the app takes the phone layout. */
export const PHONE_QUERY = '(pointer: coarse), (max-width: 600px)';

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
