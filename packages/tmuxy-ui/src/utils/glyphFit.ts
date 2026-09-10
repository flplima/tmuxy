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
 * A glyph can be fat in two different ways, and both have to be measured.
 * Its ADVANCE — how far the cursor moves — is what pushes the rest of the run
 * along, and `⎿` advances ~1.6 cells. Its INK — what is actually painted — can
 * overflow a perfectly ordinary advance: the Nerd Font icons mostly advance
 * exactly one cell and then paint a third of a cell past it, so nothing shifts
 * and the glyph still lands on top of its neighbour. The bigger of the two
 * ratios is what has to fit.
 *
 * Both are measured once, from a probe laid out with the real terminal styles,
 * and cached by cell string. A glyph that measures fat gets its own 1-cell box
 * and a `scale()` that shrinks it into the cell (see `.terminal-fit`), so the
 * rest of the line stays on the grid — which is what a terminal emulator does
 * with an icon too big for its cell. Ratios are size-independent, so a
 * font-size change needs no re-measurement; a font swap (the webfont finishing
 * its load) does, and clears the cache.
 */

/** Above this many cells a one-column glyph is shrunk into its cell. */
const FAT_THRESHOLD = 1.15;

/** Cell string → how many cells it needs, the larger of advance and ink. */
const ratios = new Map<string, number>();

/**
 * Measurements are cached, so a caller that already drew a line has no reason
 * to ask again — but the answer changes when the fonts do, and a line drawn
 * with a stale one keeps its stale layout until something re-renders it. This
 * is that something: the cache clears and everything measuring against it is
 * told, once.
 */
let version = 0;
const listeners = new Set<() => void>();

function invalidate(): void {
  ratios.clear();
  version++;
  for (const listener of listeners) listener();
}

export function subscribeGlyphFit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGlyphFitVersion(): number {
  return version;
}

if (typeof document !== 'undefined' && document.fonts) {
  // A ratio measured under the fallback font is wrong once the webfont lands.
  document.fonts.addEventListener('loadingdone', invalidate);
}

/** The `scale()` that fits a glyph of `ratio` cells into one cell, or null if it already fits. */
export function fitScale(ratio: number): number | null {
  return ratio > FAT_THRESHOLD ? 1 / ratio : null;
}

/**
 * Everything but ASCII is a candidate, because everything but ASCII can come
 * from a fallback font.
 *
 * A monospace font is monospace only for the glyphs it HAS. Ask it for `ơ` or
 * `ș` and, if it does not have them, the browser draws them from whatever font
 * does — at that font's advance, which owes nothing to the terminal's cell.
 * Latin Extended is where that bites: the letters look ordinary, so nobody
 * suspects them, and a Vietnamese or Romanian line quietly runs long.
 *
 * ASCII is the hot path and stays a code-point compare; everything else is
 * measured once and cached.
 */
export function needsMeasure(s: string): boolean {
  const cp = s.codePointAt(0);
  return cp !== undefined && cp > 0x7f;
}

/** The font shorthand an element paints with, for a canvas probe. */
function fontOf(el: HTMLElement): string {
  const style = getComputedStyle(el);
  return (
    style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  );
}

/** One canvas for every measurement — creating one per glyph is not free. */
let inkCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * How wide the glyph is PAINTED, which is not how far it advances. Null when
 * there is nothing trustworthy to measure with.
 *
 * A canvas draws with the fonts the document has ALREADY loaded and never
 * fetches one itself, so it can be a step behind the page: at first paint the
 * terminal is laid out in the webfont while a canvas asked the same question
 * still answers from the fallback. That answer is not merely imprecise, it is
 * about a different typeface — so it is refused rather than cached, and the
 * question is asked again on a later render.
 */
function measureInk(s: string, font: string): number | null {
  if (typeof document.fonts?.check === 'function' && !document.fonts.check(font, s)) return null;
  if (inkCanvas === undefined) {
    inkCanvas = document.createElement('canvas').getContext('2d');
  }
  if (!inkCanvas) return null;
  inkCanvas.font = font;
  const metrics = inkCanvas.measureText(s);
  const left = metrics.actualBoundingBoxLeft;
  const right = metrics.actualBoundingBoxRight;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  // `left` is how far the ink reaches BEFORE the origin, so the two sum to the
  // painted width however the glyph sits against its advance.
  const width = left + right;
  return width > 0 ? width : null;
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
  const font = fontOf(probe);
  host.removeChild(probe);
  // No layout (jsdom, a hidden document): nothing to learn, nothing to cache.
  if (!(cell > 0) || !(advance > 0)) return null;
  const advanceRatio = advance / cell;
  const ink = measureInk(s, font);
  if (ink !== null) return Math.max(advanceRatio, ink / cell);
  // The ink is unknown for now. An advance that is already fat is answer
  // enough — it came from the DOM, in the font the terminal is really using —
  // but a glyph that merely advances one cell might still paint past it, and
  // saying "it fits" would cache exactly the wrong answer. Ask again once the
  // fonts have settled, and tell whoever is drawing to come back for it.
  askAgainWhenFontsSettle();
  return advanceRatio > FAT_THRESHOLD ? advanceRatio : null;
}

/**
 * Wait for the font set once, then drop every measurement taken before it.
 * `loadingdone` fires per batch and can have fired already; `ready` is the
 * point at which a canvas answers about the same typeface the page is using.
 */
let waiting = false;
function askAgainWhenFontsSettle(): void {
  if (waiting || typeof document === 'undefined' || !document.fonts?.ready) return;
  waiting = true;
  document.fonts.ready.then(() => {
    waiting = false;
    invalidate();
  });
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
  invalidate();
}
