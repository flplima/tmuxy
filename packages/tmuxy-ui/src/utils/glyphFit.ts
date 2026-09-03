/**
 * Glyph fit — symbols that are one column to tmux but wider than one cell in
 * the font.
 *
 * tmux sizes a cell by wcwidth, the font by its own metrics, and for most
 * symbols the two agree closely enough that the cell box hides the difference.
 * Some do not: `⎿` (U+23BF, the elbow Claude Code draws before tool output)
 * is 1 column to wcwidth but ~1.6 cells in FiraCode Nerd Font, and a Nerd
 * Font icon in the private-use area can be nearly 2. A run that starts with
 * such a glyph is laid out ~0.6 cell too long: its box stays pinned to the
 * cell count, but the text inside paints past it and over whatever run comes
 * next — text drawn on top of text.
 *
 * The advance of a glyph relative to the font's cell is measured once, from a
 * probe laid out with the real terminal styles, and cached by cell string. A
 * glyph that measures fat gets its own 1-cell box and a `scale()` that shrinks
 * it into the cell (see `.terminal-fit`), so the rest of the line stays on the
 * grid. Ratios are size-independent, so a font-size change needs no
 * re-measurement; a font swap (the webfont finishing its load) does, and
 * clears the cache.
 */

/** Above this many cells a one-column glyph is shrunk into its cell. */
const FAT_THRESHOLD = 1.15;

/** Cell string → natural advance in cells (advance / the font's "M" advance). */
const ratios = new Map<string, number>();

if (typeof document !== 'undefined' && document.fonts) {
  // A ratio measured under the fallback font is wrong once the webfont lands.
  document.fonts.addEventListener('loadingdone', () => ratios.clear());
}

/** The `scale()` that fits a glyph of `ratio` cells into one cell, or null if it already fits. */
export function fitScale(ratio: number): number | null {
  return ratio > FAT_THRESHOLD ? 1 / ratio : null;
}

/**
 * Only symbols are candidates: ASCII, Latin and the rest of the BMP below
 * U+2000 are the font's own monospace glyphs. This keeps the per-cell check
 * a code-point compare for ordinary text.
 */
export function needsMeasure(s: string): boolean {
  const cp = s.codePointAt(0);
  return cp !== undefined && cp >= 0x2000;
}

function measureRatio(s: string, host: HTMLElement): number | null {
  const probe = document.createElement('pre');
  probe.className = 'terminal-content';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.top = '-9999px';
  probe.style.letterSpacing = '0';
  host.appendChild(probe);
  probe.textContent = 'MMMMMMMMMM';
  const cell = probe.getBoundingClientRect().width / 10;
  probe.textContent = s.repeat(10);
  const advance = probe.getBoundingClientRect().width / 10;
  host.removeChild(probe);
  // No layout (jsdom, a hidden document): nothing to learn, nothing to cache.
  if (!(cell > 0) || !(advance > 0)) return null;
  return advance / cell;
}

/**
 * The `scale()` a one-column cell needs to paint inside its cell, or null when
 * the glyph already fits (the common case, and every non-symbol).
 */
export function glyphFit(s: string, host: HTMLElement = document.body): number | null {
  if (!needsMeasure(s)) return null;
  let ratio = ratios.get(s);
  if (ratio === undefined) {
    if (typeof document === 'undefined') return null;
    // Mid-load the probe would measure the fallback font; wait for the swap.
    if (document.fonts && document.fonts.status === 'loading') return null;
    const measured = measureRatio(s, host);
    if (measured === null) return null;
    ratio = measured;
    ratios.set(s, ratio);
  }
  return fitScale(ratio);
}

export function resetGlyphFitCache(): void {
  ratios.clear();
}
