/**
 * Fitting the pane grid to a window tmux sized for someone else.
 *
 * Under `@tmuxy-size smallest` (the default) every client asks for what its
 * pane container holds and tmux takes the smallest, so the grid always fits.
 * The other modes size the window to something else — the largest client,
 * the one used last, a fixed `COLSxROWS` — and each client then draws that
 * grid in a cell cut to fit its own container, the way the phone layout fits
 * 80 columns (utils/phoneLayout.ts). The chrome and the sidebar columns keep
 * the measured cell; only the grid is scaled.
 *
 * Pure: no React, no machine.
 */

import type { SizePolicy } from '../domain/wire';

/** The pane grid's cell, as the machine holds it. */
export interface GridCell {
  charWidth: number;
  charHeight: number;
  /** letter-spacing that brings the font's advance up to `charWidth`. */
  cellGap: number;
  /** The grid's own font size in px when it is not the chrome's; null otherwise. */
  gridFontSize: number | null;
}

export const DEFAULT_SIZE_POLICY: SizePolicy = { mode: 'smallest' };

/** Whether two policies say the same thing (the wire hands a new object each read). */
export function sameSizePolicy(a: SizePolicy, b: SizePolicy): boolean {
  const fa = fixedGridSize(a);
  const fb = fixedGridSize(b);
  return a.mode === b.mode && fa?.cols === fb?.cols && fa?.rows === fb?.rows;
}

/** The grid a fixed `@tmuxy-size` asks for, or null under the other modes. */
export function fixedGridSize(policy: SizePolicy): { cols: number; rows: number } | null {
  return policy.mode === 'fixed' ? { cols: policy.cols, rows: policy.rows } : null;
}

/** Scales this close to 1 draw at the measured cell: a fraction of a pixel is not worth a new font. */
const SCALE_EPSILON = 0.005;

/**
 * The cell that draws `grid` inside `container`.
 *
 * `measured` is the cell the font measures at `fontPx` (the chrome's terminal
 * size). Under `smallest` it is the answer. Otherwise the cell is scaled by
 * the largest factor that fits the grid in both directions, keeping the
 * terminal's row ratio: a grid too big for the container shrinks; a fixed one
 * also grows to fill a container bigger than it (the app "stretches"). A
 * `largest` or `latest` grid that already fits stays at the measured cell,
 * the blank band beside it being what `smallest` leaves a larger client too.
 */
export function fitGridCell(input: {
  measured: GridCell;
  policy: SizePolicy;
  grid: { cols: number; rows: number };
  container: { width: number; height: number };
  fontPx: number;
}): GridCell {
  const { measured, policy, grid, container, fontPx } = input;
  if (policy.mode === 'smallest') return measured;
  if (grid.cols <= 0 || grid.rows <= 0 || container.width <= 0 || container.height <= 0) {
    return measured;
  }
  const scale = Math.min(
    container.width / (grid.cols * measured.charWidth),
    container.height / (grid.rows * measured.charHeight),
  );
  if (policy.mode !== 'fixed' && scale >= 1) return measured;
  if (Math.abs(scale - 1) < SCALE_EPSILON) return measured;

  const advancePerPx = (measured.charWidth - measured.cellGap) / fontPx;
  const fontSize = Math.floor(fontPx * scale * 10) / 10;
  const charWidth = measured.charWidth * scale;
  return {
    charWidth,
    // Floored, so `rows` whole rows never overrun the container.
    charHeight: Math.max(1, Math.floor(measured.charHeight * scale)),
    cellGap: charWidth - fontSize * advancePerPx,
    gridFontSize: fontSize,
  };
}
