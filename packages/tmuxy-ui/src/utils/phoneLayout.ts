/**
 * The phone layout: on a narrow window or a coarse pointer the app is the
 * whole 80 × 25 terminal on top, a key row under it and the tab/pane tree
 * below that. No tab strip, no bottom bar of its own.
 *
 * The pty is never sized to the phone. The client asks for the classic 80 × 24
 * window (tmux's status line is the 25th row, drawn under it) and shrinks the
 * cell until 80 columns span the screen, keeping the terminal's row ratio so
 * the browser's pinch zoom reads true. The chrome keeps its own size.
 *
 * Pure: no React, no machine.
 */

import { CHAR_HEIGHT } from '../constants';
import { DEFAULT_FONT_SIZE } from './fontSizeManager';

/** When the app takes the phone layout. */
export const PHONE_QUERY = '(pointer: coarse), (max-width: 600px)';

/** The window a phone asks for; tmux's status line is drawn as a 25th row. */
export const PHONE_COLS = 80;
export const PHONE_ROWS = 24;

/** Row height over font size: 24px rows at the 15px terminal size. */
const ROW_RATIO = CHAR_HEIGHT / DEFAULT_FONT_SIZE;

export interface PhoneCell {
  /** Cell width in CSS px, a whole number of device pixels. */
  cellWidth: number;
  /** letter-spacing that brings the font's advance up to `cellWidth`. */
  cellGap: number;
  /** The terminal font size, in px, that fits a cell. */
  fontSize: number;
  /** Row height in whole px. */
  rowHeight: number;
}

/**
 * The cell that fits 80 columns into `containerWidth`.
 *
 * `advancePerPx` is the terminal font's advance per pixel of font size (about
 * 0.6 for FiraCode): the width is floored to a device pixel so the grid never
 * overflows, the font is the largest whose advance fits it, and the gap pads
 * the rest.
 */
export function phoneCell(
  containerWidth: number,
  advancePerPx: number,
  devicePixelRatio: number,
): PhoneCell {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cellWidth = Math.floor((containerWidth / PHONE_COLS) * dpr) / dpr;
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
