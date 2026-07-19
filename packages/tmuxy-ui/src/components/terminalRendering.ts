/**
 * Imperative DOM rendering for terminal lines.
 *
 * Used ONLY by ScrollbackTerminal (copy mode). Terminal (normal mode) has a
 * separate React-based renderer in TerminalLine.tsx — the two implementations
 * must be kept in sync manually.
 * Groups consecutive cells by style into <span> elements for efficiency.
 */

import type { CellLine, CellStyle, CellColor } from '../tmux/types';
import { cellColorToCss, isWideChar } from './terminalShared';
import { detectUrls } from '../utils/urlDetect';

// ============================================
// Color conversion
// ============================================

// Color conversion + wide-char classification live in terminalShared.ts,
// shared with TerminalLine.tsx so the two renderers can't drift on them.

// ============================================
// Style helpers
// ============================================

function applyStyleToElement(
  el: HTMLSpanElement,
  style: CellStyle | undefined,
  selected: boolean,
): void {
  if (selected) {
    el.className = 'terminal-selected';
    el.style.color = 'var(--term-black)';
    el.style.backgroundColor = '#c0c0c0';
  }

  if (!style) return;

  let fg = style.fg !== undefined ? cellColorToCss(style.fg) : '';
  let bg = style.bg !== undefined ? cellColorToCss(style.bg) : '';

  if (style.inverse) {
    const tmp = fg;
    fg = bg || 'var(--terminal-bg, #000)';
    bg = tmp || 'var(--terminal-fg, #fff)';
  }

  if (!selected) {
    if (fg) el.style.color = fg;
    if (bg) el.style.backgroundColor = bg;
  }

  if (style.bold) el.style.fontWeight = 'bold';
  if (style.dim) el.style.opacity = '0.5';
  if (style.italic) el.style.fontStyle = 'italic';
  if (style.underline) el.style.textDecoration = 'underline';

  if (style.url) {
    el.dataset.href = style.url;
    el.style.cursor = 'pointer';
    el.style.textDecoration = 'underline';
  }
}

export function stylesMatch(a: CellStyle | undefined, b: CellStyle | undefined): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    colorEqual(a.fg, b.fg) &&
    colorEqual(a.bg, b.bg) &&
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.dim ?? false) === (b.dim ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.inverse ?? false) === (b.inverse ?? false) &&
    a.url === b.url
  );
}

function colorEqual(a: CellColor | undefined, b: CellColor | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'number') return a === b;
  if (typeof a === 'object' && typeof b === 'object') {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return false;
}

// ============================================
// Line rendering
// ============================================

function lineSliceText(line: CellLine, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += line[i].c;
  return s;
}

/**
 * Detect the dominant background color for a line.
 * If more than half the cells share the same non-default bg, return it as CSS.
 * This covers neovim/lazyvim theme backgrounds that differ from the terminal default.
 */
function detectLineBg(line: CellLine): string | null {
  if (line.length === 0) return null;

  // Fast path: check the first cell — most theme backgrounds are uniform
  const firstBg = line[0].s?.bg;
  if (firstBg === undefined) return null;

  // Verify at least half the line shares this bg (avoid false positives from
  // syntax highlighting putting bg on just a few cells)
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (colorEqual(line[i].s?.bg, firstBg)) count++;
  }
  if (count > line.length / 2) {
    return cellColorToCss(firstBg);
  }
  return null;
}

/**
 * Render a cell line into a DOM element, replacing its children.
 * Groups consecutive cells by style for efficiency (fewer spans).
 */
export function renderLineToDOM(
  el: HTMLDivElement,
  line: CellLine,
  selRange: { startCol: number; endCol: number } | null,
): void {
  el.textContent = '';
  // Reset inline background so stale colors don't persist across updates
  el.style.backgroundColor = '';

  if (line.length === 0) return;

  // Detect line background: find the most common bg color across cells.
  // When apps like neovim set a theme background (e.g. #1e1e2e), empty cells
  // and line gaps would otherwise show the container's #000 background,
  // creating visible black lines between rows.
  const lineBg = detectLineBg(line);
  if (lineBg) el.style.backgroundColor = lineBg;

  // Auto-detect URLs in line text
  const lineText = lineSliceText(line, 0, line.length);
  const autoUrls = detectUrls(lineText);
  const urlIdxOf = (i: number): number => {
    for (let u = 0; u < autoUrls.length; u++) {
      if (i >= autoUrls[u].start && i < autoUrls[u].end) return u;
    }
    return -1;
  };

  let groupStart = 0;
  let groupStyle = line[0].s;
  let groupSelected = selRange ? 0 >= selRange.startCol && 0 <= selRange.endCol : false;
  let groupUrlIdx = line[0].s?.url ? -1 : urlIdxOf(0);
  let groupWide = isWideChar(line[0].c);

  const flush = (end: number) => {
    const text = lineSliceText(line, groupStart, end);
    const oscUrl = groupStyle?.url;
    const autoUrl = !oscUrl && groupUrlIdx >= 0 ? autoUrls[groupUrlIdx].url : undefined;
    const linkUrl = oscUrl || autoUrl;

    let target: HTMLElement;
    if (linkUrl) {
      const a = document.createElement('a');
      a.href = linkUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = oscUrl ? 'terminal-hyperlink' : 'terminal-autolink';
      target = a;
    } else {
      target = document.createElement('span');
    }
    applyStyleToElement(target as HTMLSpanElement, groupStyle, groupSelected);
    // Pin the span to an exact number of character cells, matching
    // TerminalLine's stable-grid behaviour: a glyph whose advance differs
    // from the cell (emoji, CJK) paints within/over its fixed box instead of
    // pushing the rest of the line. Wide chars sit in their own 1-cell box
    // (see the group-break below) and overflow into the blank continuation
    // cell — previously the scrollback renderer had neither, so wide glyphs
    // misaligned copy-mode lines against the live-terminal grid.
    target.style.width = `${end - groupStart}ch`;
    target.textContent = text;
    el.appendChild(target);
  };

  for (let i = 1; i < line.length; i++) {
    const cell = line[i];
    const selected = selRange ? i >= selRange.startCol && i <= selRange.endCol : false;
    const cellUrlIdx = cell.s?.url ? -1 : urlIdxOf(i);
    const wide = isWideChar(cell.c);
    if (
      wide ||
      groupWide ||
      !stylesMatch(cell.s, groupStyle) ||
      selected !== groupSelected ||
      cellUrlIdx !== groupUrlIdx
    ) {
      flush(i);
      groupStart = i;
      groupStyle = cell.s;
      groupSelected = selected;
      groupUrlIdx = cellUrlIdx;
      groupWide = wide;
    }
  }
  flush(line.length);

  // Pad selection beyond line content
  if (selRange && selRange.endCol >= line.length) {
    const padStart = Math.max(selRange.startCol, line.length);
    const padLen = selRange.endCol - padStart + 1;
    if (padLen > 0) {
      const span = document.createElement('span');
      span.className = 'terminal-selected';
      span.style.color = 'var(--term-black)';
      span.style.backgroundColor = '#c0c0c0';
      span.textContent = ' '.repeat(padLen);
      el.appendChild(span);
    }
  }
}
