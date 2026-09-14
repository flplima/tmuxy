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
 * Symbols outside the wide blocks below that tmux still gives two columns:
 * every code point Unicode marks East Asian Wide in the technical, geometric,
 * Misc Symbols, Dingbats and arrows blocks, plus the few emoji below U+1F300.
 * They are the symbols that default to emoji presentation, so they paint two
 * cells wide in every font.
 */
const EMOJI_PRESENTATION_WIDE: ReadonlySet<number> = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
  0x1f004, 0x1f0cf, 0x1f18e, 0x1f191, 0x1f192, 0x1f193, 0x1f194, 0x1f195, 0x1f196, 0x1f197, 0x1f198,
  0x1f199, 0x1f19a,
]);

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
  // U+FE0F (variation selector-16) requests emoji presentation, which renders
  // ~2 cells wide even when the base code point is a narrow text symbol
  // (e.g. U+2764 "❤" is 1 cell, "❤️" is 2). The base alone doesn't say which,
  // so check the whole cell string, not just its first code point.
  if (s.includes('\uFE0F')) return true;
  const cp = s.codePointAt(0);
  if (cp === undefined) return false;
  // Misc Symbols and Dingbats (U+2600–U+27BF) are NOT listed as a block. Most
  // of their text-presentation glyphs sit within a cell (measured: ❤ and ✔
  // advance 0.978), and the block also holds ❯, the default zsh prompt
  // character, which would otherwise get its own span on every prompt line.
  // Only the code points tmux itself gives two columns are listed: the ones
  // Unicode marks East Asian Wide, which are exactly the symbols that default
  // to emoji presentation (✅ ❌ ⭐ ⚡ …). Left out, they fell to the glyph-fit
  // path, which squeezed a two-column emoji into one cell at half size.
  if (EMOJI_PRESENTATION_WIDE.has(cp)) return true;
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
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators (flags: a pair is one 2-cell cell)
    (cp >= 0x1f200 && cp <= 0x1f265) || // enclosed ideographic supplement (🈚 🉐)
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B and beyond
  );
}

/**
 * CSS length for `n` cells on the terminal grid.
 *
 * `--cell-w` is the snapped cell width the app root publishes from the single
 * font measurement (see `utils/cellMetrics.ts`), so every cell-addressed box —
 * style-group spans, the cursor overlay, image placements — is a whole multiple
 * of the same width the pane rectangles use. Outside the app (component
 * stories) the variable is absent and `1ch`, the font's natural advance, is
 * the grid instead.
 */
export function cellsToCss(n: number): string {
  return `calc(${n} * var(--cell-w, 1ch))`;
}
