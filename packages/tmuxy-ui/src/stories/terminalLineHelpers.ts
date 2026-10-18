import type { CellLine } from '../domain/wire';

export function text(str: string): CellLine {
  return str.split('').map((c) => ({ c }));
}

export function styled(str: string, style: Record<string, unknown>): CellLine {
  return str.split('').map((c) => ({ c, s: style }));
}

/**
 * A wide character as the backend emits it: the character in one cell plus a
 * blank continuation cell, so the line's cell count already covers both
 * columns. `c` may be several code units (emoji + VS16, ZWJ sequences).
 */
export function wide(c: string): CellLine {
  return [{ c }, { c: ' ' }];
}

/** Boxes are pinned to whole cells; allow a quarter-pixel of rounding. */
export const CELL_TOLERANCE = 0.05;

export function spanWithText(canvasElement: HTMLElement, needle: string): HTMLElement {
  const spans = Array.from(canvasElement.querySelectorAll<HTMLElement>('.terminal-line > span'));
  const el = spans.find((s) => s.textContent === needle);
  if (!el) throw new Error(`no span with text ${JSON.stringify(needle)}`);
  return el;
}

export function grid(canvasElement: HTMLElement): HTMLElement {
  return canvasElement.querySelector('.terminal-container') as HTMLElement;
}

/** A Nerd Font branch icon — private-use area, so no fallback font has it. */
export const ICON = '';

/** An editor's cursor line: every cell on the row carries its background. */
export const CURSOR_LINE = { bg: 237 };

/**
 * The component and play function have to be looking at the SAME
 * typeface. A canvas answers from the faces the document has already
 * loaded and never fetches one itself, so both `glyphFit` and the probe
 * below can measure the fallback font while the page is laid out in the
 * real one — and they can do it at different moments, which is how the
 * branch below ended up disagreeing with the DOM. Asking for the face this
 * glyph needs, and waiting for it, takes the moment out of the question.
 */
export async function measureGlyphNaturalInk(
  canvasElement: HTMLElement,
  glyph: string,
): Promise<number> {
  const paneStyle = getComputedStyle(grid(canvasElement).querySelector('.terminal-content')!);
  const font =
    paneStyle.font ||
    `${paneStyle.fontStyle} ${paneStyle.fontWeight} ${paneStyle.fontSize} ${paneStyle.fontFamily}`;

  await document.fonts.load(font, glyph);
  await document.fonts.ready;

  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const metrics = probe.measureText(glyph);
  return metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
}
