import { paneNumber, type PaneId } from '../../domain/ids';
import type { CellColor, CellStyle } from '../../domain/wireCells';
import { isTauri, tauriSchemeUrl } from '../../infra/platform';

/** The --term-* variables every theme CSS file defines. */
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

/**
 * 256-colour and RGB cells go through the theme too: `--term-extended-colors`
 * of the cell's own colour, the rest its lightness between the pane's
 * foreground and background — so a monochrome theme (0%) draws a TUI's
 * truecolor in its own two colours, and every other (100%) draws it exactly.
 */
export function cellColorToCss(color: CellColor): string {
  if (typeof color === 'number' && color < 16) return STANDARD_16_VARS[color];
  const [r, g, b] = typeof color === 'number' ? ansi256Rgb(color) : [color.r, color.g, color.b];
  const lightness = Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) / 2.55);
  return (
    `color-mix(in srgb, rgb(${r}, ${g}, ${b}) var(--term-extended-colors), ` +
    `color-mix(in srgb, var(--term-foreground) ${lightness}%, var(--term-background)))`
  );
}

/** xterm's 256-colour palette, for index >= 16. */
function ansi256Rgb(index: number): [number, number, number] {
  // 6x6x6 colour cube
  if (index < 232) {
    const i = index - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return [level(Math.floor(i / 36)), level(Math.floor((i % 36) / 6)), level(i % 6)];
  }

  // 24-step grayscale ramp
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
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
 * Whether a cell's character is double-width: CJK ideographs, kana, Hangul,
 * fullwidth forms, and emoji.
 *
 * vt100 already emits such a character as TWO cells (the character plus a
 * blank continuation), so this only keeps a wide character in its OWN span,
 * where its ~2-cell glyph overflows into the continuation instead of pushing
 * the rest of a grouped span off the grid. Over-detection is harmless, so the
 * ranges err toward the East Asian "Wide"/"Fullwidth" and emoji blocks.
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
  // Misc Symbols and Dingbats (U+2600–U+27BF) are not a wide block: most of
  // their text-presentation glyphs sit within a cell (measured: ❤ and ✔
  // advance 0.978), and the block holds ❯, the default zsh prompt character.
  // Only the code points tmux gives two columns are listed — the ones Unicode
  // marks East Asian Wide, the emoji-presentation symbols (✅ ❌ ⭐ ⚡ …) —
  // or glyph fit would squeeze a two-column emoji into one cell.
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

export function sameCellColor(a: CellColor | undefined, b: CellColor | undefined): boolean {
  return (
    a === b ||
    (typeof a === 'object' && typeof b === 'object' && a.r === b.r && a.g === b.g && a.b === b.b)
  );
}

/** An unset attribute equals one set false: the backend writes either `{}` or `{ bold: false }`. */
export function sameCellStyle(a: CellStyle | undefined, b: CellStyle | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      sameCellColor(a.fg, b.fg) &&
      sameCellColor(a.bg, b.bg) &&
      !a.bold === !b.bold &&
      !a.dim === !b.dim &&
      !a.italic === !b.italic &&
      !a.underline === !b.underline &&
      !a.inverse === !b.inverse &&
      a.url === b.url &&
      a.size === b.size)
  );
}

const BIDI_CONTROL_TEST = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Neutralize Unicode BiDi override, isolate, and directional-mark code points
 * inside a terminal cell so untrusted output cannot visually reorder commands
 * or filenames across cells. A cell carrying a base glyph plus combining BiDi
 * controls keeps its base glyph; a cell holding only BiDi controls renders a
 * replacement character so column alignment stays 1:1.
 */
export function sanitizeTerminalCell(c: string): string {
  if (!BIDI_CONTROL_TEST.test(c)) return c;
  const stripped = c.replace(BIDI_CONTROL_RE, '');
  return stripped.length > 0 ? stripped : '\uFFFD';
}

/**
 * The web server serves image bytes at `/api/images/...`; the desktop app has
 * no HTTP and serves them over its `tmuxyimg:` scheme
 * (`tmuxy-tauri-app/src/gui.rs`). Tests and stories override it with
 * `window.__tmuxyImageSrc`.
 */
export function resolveImageSrc(paneId: PaneId, imageId: number): string {
  const numericPaneId = paneNumber(paneId);
  if (typeof window !== 'undefined') {
    const override = (
      window as unknown as {
        __tmuxyImageSrc?: (paneId: string, imageId: number) => string | undefined;
      }
    ).__tmuxyImageSrc;
    if (override) {
      const resolved = override(paneId, imageId);
      if (resolved) return resolved;
    }
    if (isTauri()) return tauriSchemeUrl('tmuxyimg', `/${numericPaneId}/${imageId}`);
  }
  return `/api/images/${numericPaneId}/${imageId}`;
}
