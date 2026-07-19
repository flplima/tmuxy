/**
 * Pure helpers shared by BOTH terminal renderers:
 *
 * - `TerminalLine.tsx` — the React renderer used by Terminal (normal mode)
 * - `terminalRendering.ts` — the imperative DOM renderer used by
 *   ScrollbackTerminal (copy mode)
 *
 * The render paths themselves stay separate (JSX vs direct DOM for perf),
 * but the color mapping and wide-character classification must agree or the
 * two modes render the same content differently. These used to be
 * copy-pasted in both files and had already begun to drift.
 */

import type { CellColor } from '../tmux/types';

/**
 * CSS variables for the standard 16 ANSI colors.
 * These match the --term-* variables defined in each theme CSS file.
 */
export const STANDARD_16_VARS = [
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

/**
 * Convert CellColor to a CSS color string. Standard 16 colors go through the
 * theme CSS variables; extended 256 colors and RGB are computed.
 */
export function cellColorToCss(color: CellColor): string {
  if (typeof color === 'number') {
    if (color < 16) return STANDARD_16_VARS[color];
    return getAnsi256Color(color);
  }
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/**
 * Get ANSI 256 color as hex. Only ever called for index >= 16 —
 * `cellColorToCss` handles 0..15 via the theme CSS-var path before reaching
 * here.
 */
export function getAnsi256Color(index: number): string {
  // 216 color cube (6x6x6)
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // 24 grayscale
  const gray = 8 + (index - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/**
 * Whether a cell's character is double-width (occupies two terminal columns):
 * CJK ideographs, kana, Hangul, fullwidth forms, and emoji.
 *
 * The backend (vt100) emits such a character as TWO data cells — the character
 * plus a continuation cell rendered as a space — so the column grid already
 * accounts for both columns. We use this only to keep a wide character in its
 * OWN span: its glyph then advances ~2 cells and overflows into the (blank)
 * continuation cell instead of pushing the rest of a grouped span off the grid.
 * Over-detection is harmless (a narrow char in its own 1-cell span renders the
 * same), so the ranges err toward the standard East Asian "Wide"/"Fullwidth"
 * and emoji blocks.
 */
export function isWideChar(s: string): boolean {
  if (!s) return false;
  const cp = s.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B and beyond
  );
}
