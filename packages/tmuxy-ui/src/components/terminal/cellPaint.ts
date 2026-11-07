import type { CSSProperties } from 'react';
import type { CellLine, CellStyle } from '../../domain/wireCells';
import { cellColorToCss, isWideChar, sanitizeTerminalCell } from './terminalShared';
import { cellsToCss } from '../../infra/dom/cellMetrics';
import { glyphFit } from './glyphFit';
import { isBlockGlyph, blockGlyphStyle } from './blockGlyphs';
import { detectUrls, type DetectedUrl } from './urlDetect';

/** Inclusive. */
export interface SelectionCols {
  startCol: number;
  endCol: number;
}

export interface CellRun {
  text: string;
  cells: number;
  style: CellStyle | undefined;
  selected: boolean;
  /** `osc`: an OSC 8 hyperlink rather than a URL detected in the text. */
  link: { url: string; osc: boolean } | null;
  wide: boolean;
  blockCh: string | null;
  fit: number | null;
}

/** FNV-1a-style hash of a style (FNV offset basis and prime). */
function styleKey(s: CellStyle | undefined): number {
  if (!s) return 0;
  let h = 0x811c9dc5;
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
 * The row's auto-detected URLs, by cell: detectUrls reports UTF-16 offsets,
 * and a cell can hold several code units (variation selectors, combining marks).
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
      // A wide glyph owns a 1-cell box and overflows into its blank
      // continuation cell rather than shifting a grouped span.
      !wide &&
      !run.wide &&
      fit === null &&
      run.fit === null &&
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

/** Blank cells a selection covers past the row's cells (a line selection reaches the last column). */
export function selectionPad(line: CellLine, selection: SelectionCols | null | undefined): number {
  if (!selection || selection.endCol < line.length) return 0;
  return Math.max(0, selection.endCol - Math.max(selection.startCol, line.length) + 1);
}

/** A selected cell keeps its weight, slant and underline but takes the selection's colours. */
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

/** `links` false paints a link's text as plain text (a picture of a pane, not the pane). */
export function runPaint(
  run: CellRun,
  links = true,
): { className: string | undefined; style: CSSProperties } {
  let style: CSSProperties = run.style ? cellCss(run.style, run.selected) : {};
  const size = run.style?.size;
  // Pinned to whole cells whatever the glyphs: a glyph whose advance differs
  // from the cell (emoji, spinners, CJK) paints over its box instead of
  // pushing the rest of the line. A DEC / OSC 66 scaled run is twice as wide.
  style.width = cellsToCss(run.cells * (size ? 2 : 1));
  // Block Elements are CSS rectangles so stacked rows tile seamlessly (a
  // font's glyph does not fill the cell); the character stays as transparent
  // text for copy/paste.
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
 * The background a row's edge takes (`RowEdges`), so a status line or an
 * editor gutter painted edge to edge reaches the pane border.
 */
export function rowEdgeBackground(style: CellStyle | undefined): string | undefined {
  if (!style) return undefined;
  const fg = style.fg !== undefined ? cellColorToCss(style.fg) : '';
  const bg = style.bg !== undefined ? cellColorToCss(style.bg) : '';
  const painted = style.inverse ? fg || 'var(--term-foreground)' : bg;
  return painted || undefined;
}
