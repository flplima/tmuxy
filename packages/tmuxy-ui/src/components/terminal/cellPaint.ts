/**
 * How a row of cells is painted, once for both renderers: the live grid's
 * React rows (`TerminalLine`) and the scroll view's imperative rows
 * (`terminalRendering.ts`). A row is cut into runs — cells that share a style,
 * a selection state and a link, with a wide glyph, a block element and a fat
 * glyph each on its own — and each run's class and inline style come from
 * `runPaint`. The two renderers only differ in how they put the result in the
 * DOM.
 */

import type { CSSProperties } from 'react';
import type { CellLine, CellStyle } from '../../domain/wireCells';
import { cellColorToCss, cellsToCss, isWideChar, sanitizeTerminalCell } from './terminalShared';
import { glyphFit } from './glyphFit';
import { isBlockGlyph, blockGlyphStyle } from './blockGlyphs';
import { detectUrls, type DetectedUrl } from './urlDetect';

/** The columns of a row a selection covers, inclusive. */
export interface SelectionCols {
  startCol: number;
  endCol: number;
}

/** Cells painted as one box. */
export interface CellRun {
  text: string;
  /** How many cells the run covers. */
  cells: number;
  style: CellStyle | undefined;
  selected: boolean;
  /** The link the run is part of: an OSC 8 hyperlink, or a URL detected in the text. */
  link: { url: string; osc: boolean } | null;
  /** A two-column glyph, which paints past its one-cell box into the next. */
  wide: boolean;
  /** A Block Element drawn as CSS rectangles. */
  blockCh: string | null;
  /** `scale()` that fits a fat one-column glyph into its cell (`glyphFit`). */
  fit: number | null;
}

/**
 * Compute a numeric key for grouping cells by style.
 * Uses a FNV-1a-inspired hash of the style properties to avoid JSON.stringify.
 */
function styleKey(s: CellStyle | undefined): number {
  if (!s) return 0;
  let h = 0x811c9dc5; // FNV offset basis
  if (s.fg !== undefined) {
    if (typeof s.fg === 'number') {
      h = (h ^ (s.fg + 256)) * 0x01000193;
    } else {
      h = (h ^ (s.fg.r + 65536)) * 0x01000193;
      h = (h ^ (s.fg.g + 65792)) * 0x01000193;
      h = (h ^ (s.fg.b + 66048)) * 0x01000193;
    }
  }
  if (s.bg !== undefined) {
    if (typeof s.bg === 'number') {
      h = (h ^ (s.bg + 512)) * 0x01000193;
    } else {
      h = (h ^ (s.bg.r + 66304)) * 0x01000193;
      h = (h ^ (s.bg.g + 66560)) * 0x01000193;
      h = (h ^ (s.bg.b + 66816)) * 0x01000193;
    }
  }
  if (s.bold) h = (h ^ 1) * 0x01000193;
  if (s.italic) h = (h ^ 2) * 0x01000193;
  if (s.underline) h = (h ^ 4) * 0x01000193;
  if (s.inverse) h = (h ^ 8) * 0x01000193;
  if (s.dim) h = (h ^ 16) * 0x01000193;
  if (s.size === 'dwl') h = (h ^ 32) * 0x01000193;
  else if (s.size === 'dhl-top') h = (h ^ 64) * 0x01000193;
  else if (s.size === 'dhl-bottom') h = (h ^ 96) * 0x01000193;
  if (s.url) {
    for (let i = 0; i < s.url.length; i++) {
      h = (h ^ s.url.charCodeAt(i)) * 0x01000193;
    }
  }
  return h | 0;
}

/**
 * The row's auto-detected URLs, by cell: detectUrls reports UTF-16 offsets
 * into the joined text, but a cell can hold more than one code unit
 * (variation selectors, combining marks), so each cell's offset is mapped
 * rather than compared to a string offset as is.
 */
export function rowUrlIndex(
  line: CellLine,
  rowUrls?: DetectedUrl[],
): { urls: DetectedUrl[]; urlAt: (cell: number) => number } {
  const offsets = new Array<number>(line.length);
  let text = '';
  for (let i = 0; i < line.length; i++) {
    offsets[i] = text.length;
    text += sanitizeTerminalCell(line[i].c);
  }
  const urls = rowUrls ?? detectUrls(text);
  const urlAt = (cell: number): number => {
    const off = offsets[cell];
    for (let u = 0; u < urls.length; u++) {
      if (off >= urls[u].start && off < urls[u].end) return u;
    }
    return -1;
  };
  return { urls, urlAt };
}

/** A row cut into the runs it is painted as. */
export function cellRuns(
  line: CellLine,
  selection: SelectionCols | null | undefined,
  { urls, urlAt }: ReturnType<typeof rowUrlIndex>,
): CellRun[] {
  const runs: CellRun[] = [];
  let run: (CellRun & { sk: number; urlIdx: number }) | null = null;
  for (let i = 0; i < line.length; i++) {
    const cell = line[i];
    const sk = styleKey(cell.s);
    const selected = !!selection && i >= selection.startCol && i <= selection.endCol;
    // An OSC 8 link wins over detection.
    const urlIdx = cell.s?.url ? -1 : urlAt(i);
    const wide = isWideChar(cell.c);
    const blockCh = isBlockGlyph(cell.c) ? cell.c : null;
    const fit = !wide && !blockCh ? glyphFit(cell.c) : null;
    if (
      run &&
      // A wide char is never grouped (with its continuation cell or anything
      // else): its 2-column glyph must own a 1-cell box so it overflows into
      // the blank continuation cell rather than shifting a grouped span.
      !wide &&
      !run.wide &&
      // A fat glyph is shrunk on its own; it never shares a box.
      fit === null &&
      run.fit === null &&
      // A geometric block run is one repeated glyph: a different block
      // char (or ordinary text) needs its own box to paint into.
      blockCh === run.blockCh &&
      sk === run.sk &&
      selected === run.selected &&
      urlIdx === run.urlIdx
    ) {
      run.text += sanitizeTerminalCell(cell.c);
      run.cells++;
      continue;
    }
    const osc = cell.s?.url;
    run = {
      text: sanitizeTerminalCell(cell.c),
      cells: 1,
      style: cell.s,
      selected,
      link: osc
        ? { url: osc, osc: true }
        : urlIdx >= 0
          ? { url: urls[urlIdx].url, osc: false }
          : null,
      wide,
      blockCh,
      fit,
      sk,
      urlIdx,
    };
    runs.push(run);
  }
  return runs;
}

/**
 * How many blank cells a selection covers past the end of the row's cells
 * (a line selection reaches the pane's last column), or 0.
 */
export function selectionPad(line: CellLine, selection: SelectionCols | null | undefined): number {
  if (!selection || selection.endCol < line.length) return 0;
  return Math.max(0, selection.endCol - Math.max(selection.startCol, line.length) + 1);
}

/**
 * A cell style as CSS. A selected cell keeps its weight, slant and underline
 * but none of its colours: every selected cell is the selection's
 * (`.terminal-selected`, styles/terminal.css), whatever it was drawn in.
 */
function cellCss(style: CellStyle, selected: boolean): CSSProperties {
  const css: CSSProperties = {};
  if (style.bold) css.fontWeight = 'bold';
  if (style.italic) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (selected) return css;
  if (style.fg !== undefined) css.color = cellColorToCss(style.fg);
  if (style.bg !== undefined) css.backgroundColor = cellColorToCss(style.bg);
  if (style.dim) css.opacity = 0.5;
  if (style.inverse) {
    const fg = css.color;
    const bg = css.backgroundColor;
    css.color = bg || 'var(--term-background)';
    css.backgroundColor = fg || 'var(--term-foreground)';
  }
  return css;
}

/**
 * A run's box: its classes and inline style. `links` false paints a link's
 * text as plain text (a picture of a pane, not the pane).
 */
export function runPaint(
  run: CellRun,
  links = true,
): { className: string | undefined; style: CSSProperties } {
  let style: CSSProperties = run.style ? cellCss(run.style, run.selected) : {};
  const size = run.style?.size;
  // Pin the span to an exact number of cells (`--cell-w`, the snapped grid
  // width — see infra/dom/cellMetrics.ts), independent of the actual glyphs in
  // the run. A glyph whose advance differs from the cell (emoji, spinner
  // symbols, CJK) then paints within / over its fixed box instead of pushing
  // the rest of the line — the horizontal jitter when only a few characters
  // changed. A DEC / OSC 66 scaled run is twice as wide.
  style.width = cellsToCss(run.cells * (size ? 2 : 1));
  // Block Elements are drawn as CSS rectangles rather than font glyphs so
  // they fill the cell exactly and stacked rows tile seamlessly. The
  // character stays as (transparent) text, keeping copy/paste intact.
  if (run.blockCh && !run.selected) {
    const painted = blockGlyphStyle(
      run.blockCh,
      (style.color as string) ?? 'var(--term-foreground)',
    );
    if (painted) style = { ...style, ...painted, color: 'transparent' };
  }
  const classes = [
    run.link && links ? (run.link.osc ? 'terminal-hyperlink' : 'terminal-autolink') : undefined,
    run.selected ? 'terminal-selected' : undefined,
    run.fit !== null ? 'terminal-fit' : undefined,
    // A wide glyph paints past its 1-cell box into the next cell; lifting
    // it keeps that cell's background from painting over its right half.
    run.wide ? 'terminal-wide' : undefined,
    size ? 'terminal-scaled' : undefined,
  ].filter(Boolean);
  return { className: classes.join(' ') || undefined, style };
}

/**
 * The background a row's edge takes (`RowEdges`): the first cell's for the
 * pane's left padding, the last cell's for everything right of the line. A
 * status line or an editor gutter painted edge to edge then reaches the pane
 * border instead of stopping half a cell short. Inverse video counts the way
 * the cell renders.
 */
export function rowEdgeBackground(style: CellStyle | undefined): string | undefined {
  if (!style) return undefined;
  const fg = style.fg !== undefined ? cellColorToCss(style.fg) : '';
  const bg = style.bg !== undefined ? cellColorToCss(style.bg) : '';
  const painted = style.inverse ? fg || 'var(--term-foreground)' : bg;
  return painted || undefined;
}
