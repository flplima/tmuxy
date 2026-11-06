/**
 * Cell metrics — the ONE measurement every pixel on the terminal grid derives
 * from.
 *
 * A browser lays text out by glyph advance, which for the terminal font at a
 * given size is usually a fraction of a pixel (FiraCode at 15px ≈ 9.0px, at
 * 13px ≈ 7.8px). Boxes placed at multiples of a fractional advance land on
 * fractional pixel edges, which the compositor snaps — so a 200-column pane
 * ends up a pixel off from where its text actually stops, and adjacent panes'
 * outlines no longer coincide.
 *
 * The fix is the one xterm.js and native terminals use: snap the cell width to
 * a whole device pixel and force the glyph advance to match with
 * `letter-spacing`. The natural advance is measured once; the snapped width and
 * the gap that makes text advance by exactly that width are published as CSS
 * custom properties on the app root:
 *
 *   --cell-w    snapped cell width in px — every cell-addressed box (style-group
 *               spans, cursor overlay, image placements, pane rectangles) is a
 *               whole multiple of it
 *   --cell-gap  letter-spacing that pads (or trims) the natural advance up to
 *               --cell-w, applied to every terminal text run
 *
 * `ch` is deliberately not the grid unit any more: it is the advance of "0"
 * with NO letter-spacing, so once the advance is snapped `1ch` stops being a
 * cell. `cellsToCss` (terminalShared) still falls back to `1ch` when the
 * variables are absent — component stories rendered outside the app keep
 * working, just without snapping.
 */

export interface CellMetrics {
  /** Natural glyph advance of the terminal font, in CSS px (unsnapped). */
  advance: number;
  /** Snapped cell width in CSS px — a whole number of device pixels. */
  cellWidth: number;
  /** `cellWidth - advance`: the letter-spacing that makes text advance by one cell. */
  cellGap: number;
}

/**
 * Snap a natural glyph advance to the nearest whole device pixel, expressed in
 * CSS px. At DPR 1 that's an integer; at DPR 2 a half-pixel multiple; at a
 * fractional DPR (1.25, 1.5) whatever CSS length is a whole device pixel.
 */
export function snapCellWidth(advance: number, devicePixelRatio: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const snapped = Math.round(advance * dpr) / dpr;
  // A degenerate measurement (font not loaded, hidden document) must never
  // collapse the grid to zero width.
  return snapped > 0 ? snapped : advance;
}

export function computeCellMetrics(advance: number, devicePixelRatio: number): CellMetrics {
  const cellWidth = snapCellWidth(advance, devicePixelRatio);
  return { advance, cellWidth, cellGap: cellWidth - advance };
}

/**
 * Measure the terminal font's natural advance by laying out a run of glyphs
 * with the real `.terminal-content` styles and NO letter-spacing (the probe
 * must not pick up the gap derived from a previous measurement).
 *
 * `host` is where the probe is attached. Measuring inside the element the grid
 * actually renders in — rather than `document.body` — means any inherited
 * property that changes the advance (an ancestor font-size, zoom, etc.) is
 * part of the measurement instead of a silent divergence.
 */
export function measureCellMetrics(host: HTMLElement = document.body): CellMetrics {
  const probe = document.createElement('pre');
  probe.className = 'terminal-content';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.top = '-9999px';
  probe.style.letterSpacing = '0';
  probe.textContent = 'MMMMMMMMMM';
  host.appendChild(probe);
  const advance = probe.getBoundingClientRect().width / 10;
  host.removeChild(probe);
  return computeCellMetrics(advance, window.devicePixelRatio || 1);
}

/**
 * The cell grid of a sidebar column, whose text is `sidebarFontPx` where the
 * panes are `paneFontPx`: glyph advances scale linearly with font size, so the
 * column's natural advance is the pane's scaled by the ratio, snapped to a
 * device pixel like any other cell. The dock's tmux pane is sized in THESE
 * cells, so its `@tmuxy-sidebar-cols` and the column's pixel width agree.
 */
export function sidebarCellMetrics(
  pane: { charWidth: number; cellGap: number },
  paneFontPx: number,
  sidebarFontPx: number,
  devicePixelRatio: number,
): CellMetrics {
  const advance = (pane.charWidth - pane.cellGap) * (sidebarFontPx / (paneFontPx || 1));
  return computeCellMetrics(advance, devicePixelRatio);
}

/**
 * Inline-style custom properties that publish the metrics to the DOM subtree.
 * Set on the app root (see App.tsx) and on story decorators that render
 * terminal content without the app.
 */
export function cellMetricsStyle(metrics: {
  cellWidth: number;
  cellGap: number;
}): Record<'--cell-w' | '--cell-gap', string> {
  return {
    '--cell-w': `${metrics.cellWidth}px`,
    '--cell-gap': `${metrics.cellGap}px`,
  };
}
