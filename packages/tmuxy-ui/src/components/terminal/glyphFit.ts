/**
 * Symbols that are one column to tmux but wider than one cell in the font.
 *
 * tmux sizes a cell by wcwidth, the font by its own metrics. `⎿` (U+23BF, the
 * elbow Claude Code draws before tool output) is 1 column to wcwidth but ~1.6
 * cells in FiraCode Nerd Font, and a Nerd Font icon in the private-use area
 * can be nearly 2, so the text paints past its box and over the next run.
 *
 * A glyph can be fat two ways. Its ADVANCE pushes the rest of the run along
 * (`⎿` advances ~1.6 cells). Its INK can overflow an ordinary advance: Nerd
 * Font icons mostly advance one cell and paint a third of a cell past it. The
 * bigger ratio is what has to fit; such a glyph gets its own 1-cell box and a
 * `scale()` into it (`.terminal-fit`), as a terminal emulator does with an
 * icon too big for its cell. Ratios are size-independent, so only a font swap
 * (the webfont finishing its load) clears the cache.
 */

import { TERMINAL_CONTENT } from '../../infra/dom/terminalDom';

/** Above this many cells a one-column glyph is shrunk into its cell. */
const FAT_THRESHOLD = 1.15;

const ratios = new Map<string, number>();

/**
 * Glyphs with no answer yet (no layout, or ink the canvas cannot measure yet),
 * not asked about again until the fonts change: every ask forces a layout,
 * once per cell per render.
 */
const unanswered = new Set<string>();

/** Bumped when the fonts change, so a line drawn with a stale answer re-renders. */
let version = 0;
const listeners = new Set<() => void>();

function invalidate(): void {
  ratios.clear();
  unanswered.clear();
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

function fontOf(el: HTMLElement): string {
  const style = getComputedStyle(el);
  return (
    style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  );
}

let inkCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * How wide the glyph is PAINTED, or null when nothing can be trusted.
 *
 * A canvas draws only with fonts the document has ALREADY loaded and never
 * fetches one itself: at first paint it can answer from the fallback while the
 * terminal is laid out in the webfont. That answer is about another typeface,
 * so it is refused rather than cached.
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
  probe.className = TERMINAL_CONTENT;
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
  // Ink unknown: a fat advance (from the DOM, in the real font) is answer
  // enough, but a one-cell advance may still paint past it, so it is not
  // cached as fitting. A canvas never fetches a face itself, so ask for it;
  // its `loadingdone` clears the cache.
  requestFace(font, s);
  return advanceRatio > FAT_THRESHOLD ? advanceRatio : null;
}

/**
 * Ask the document to load whatever face covers `s`. Not `document.fonts.ready`:
 * once the fonts have settled that promise is already resolved, and clearing
 * the cache on it re-rendered and re-asked forever. A load that brings a face
 * in fires `loadingdone`; one with nothing to bring fires nothing.
 */
function requestFace(font: string, s: string): void {
  if (typeof document.fonts?.load !== 'function') return;
  document.fonts.load(font, s).catch(() => {});
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
    if (unanswered.has(s)) return null;
    const measured = measureRatio(s, host);
    if (measured === null) {
      unanswered.add(s);
      return null;
    }
    ratio = measured;
    ratios.set(s, ratio);
  }
  return fitScale(ratio);
}
