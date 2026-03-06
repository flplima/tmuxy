/**
 * Imperative DOM rendering for terminal lines.
 *
 * Shared between Terminal (normal mode) and ScrollbackTerminal (copy mode).
 * Groups consecutive cells by style into <span> elements for efficiency.
 */

import type { CellLine, CellStyle, CellColor } from '../tmux/types';

// ============================================
// Color conversion
// ============================================

const STANDARD_16_VARS = [
  'var(--term-black)',
  'var(--term-red)',
  'var(--term-green)',
  'var(--term-yellow)',
  'var(--term-blue)',
  'var(--term-magenta)',
  'var(--term-cyan)',
  'var(--term-white)',
  'var(--term-bright-black)',
  'var(--term-bright-red)',
  'var(--term-bright-green)',
  'var(--term-bright-yellow)',
  'var(--term-bright-blue)',
  'var(--term-bright-magenta)',
  'var(--term-bright-cyan)',
  'var(--term-bright-white)',
];

function cellColorToCss(color: CellColor): string {
  if (typeof color === 'number') {
    if (color < 16) return STANDARD_16_VARS[color];
    return getAnsi256Color(color);
  }
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function getAnsi256Color(index: number): string {
  const standard16 = [
    '#000000',
    '#cd0000',
    '#00cd00',
    '#cdcd00',
    '#0000ee',
    '#cd00cd',
    '#00cdcd',
    '#e5e5e5',
    '#7f7f7f',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#5c5cff',
    '#ff00ff',
    '#00ffff',
    '#ffffff',
  ];
  if (index < 16) return standard16[index];
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = 8 + (index - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

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
 * Detect the dominant background color for a pane's content.
 * Samples multiple lines to find the most common non-default background.
 * Used to set the container background so gaps match the theme.
 */
export function detectPaneBg(content: CellLine[]): string | null {
  // Sample up to 5 lines from the content
  const sampleIndices = [
    0,
    Math.floor(content.length / 4),
    Math.floor(content.length / 2),
    Math.floor((content.length * 3) / 4),
    content.length - 1,
  ];
  for (const idx of sampleIndices) {
    const line = content[idx];
    if (!line || line.length === 0) continue;
    const bg = detectLineBg(line);
    if (bg) return bg;
  }
  return null;
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

  let groupStart = 0;
  let groupStyle = line[0].s;
  let groupSelected = selRange ? 0 >= selRange.startCol && 0 <= selRange.endCol : false;

  const flush = (end: number) => {
    const text = lineSliceText(line, groupStart, end);
    const span = document.createElement('span');
    applyStyleToElement(span, groupStyle, groupSelected);
    span.textContent = text;
    el.appendChild(span);
  };

  for (let i = 1; i < line.length; i++) {
    const cell = line[i];
    const selected = selRange ? i >= selRange.startCol && i <= selRange.endCol : false;
    if (!stylesMatch(cell.s, groupStyle) || selected !== groupSelected) {
      flush(i);
      groupStart = i;
      groupStyle = cell.s;
      groupSelected = selected;
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
