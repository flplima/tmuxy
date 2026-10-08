import { describe, it, expect } from 'vitest';
import { isWideChar, sameCellColor, sameCellStyle } from '../terminalShared';

describe('isWideChar', () => {
  it('classifies plain ASCII as narrow', () => {
    expect(isWideChar('A')).toBe(false);
    expect(isWideChar(' ')).toBe(false);
    expect(isWideChar('')).toBe(false);
  });

  it('classifies CJK and emoji as wide', () => {
    expect(isWideChar('中')).toBe(true);
    expect(isWideChar('あ')).toBe(true);
    expect(isWideChar('\u{1F600}')).toBe(true);
  });

  it('treats an emoji-presentation sequence as wide', () => {
    // U+2764 alone is a 1-cell text symbol, but U+2764 U+FE0F renders ~2 cells.
    // Looking only at the base code point misclassified it as narrow, so it got
    // grouped with its neighbours and its double-width glyph pushed the rest of
    // the run off the column grid.
    expect(isWideChar('❤️')).toBe(true);
    expect(isWideChar('☑️')).toBe(true);
  });

  it('treats the symbols tmux gives two columns as wide, and only those', () => {
    // ✅ ❌ ⭐ ⚡ sit among narrow symbols but default to emoji presentation, and
    // tmux gives them two columns. Classified narrow, they went to the glyph-fit
    // path, which shrank a two-column emoji into one cell at half size.
    for (const ch of ['✅', '❌', '⭐', '⚡', '⌛', '⬛', '➕', '🀄', '🆎', '🈚']) {
      expect({ ch, wide: isWideChar(ch) }).toEqual({ ch, wide: true });
    }
    // Their text-presentation neighbours stay narrow — ❯ above all, the zsh
    // prompt character, which would otherwise get a span of its own per prompt.
    for (const ch of ['❯', '❤', '✔', '☑', '⚠', '→', '★']) {
      expect({ ch, wide: isWideChar(ch) }).toEqual({ ch, wide: false });
    }
  });

  it('treats combined emoji cells as wide: ZWJ sequence, skin tone, flag', () => {
    // The backend (mirroring tmux's screen_write_combine) keeps each of these
    // in ONE cell. The first code point decides: 👩 / 👍 are pictographs; a
    // flag starts with a regional indicator, which is outside the pictograph
    // block and used to be classified narrow — so the flag was grouped into
    // the ASCII run and its 2-cell glyph pushed the rest of the line.
    expect(isWideChar('\u{1F469}\u200D\u{1F4BB}')).toBe(true);
    expect(isWideChar('\u{1F44D}\u{1F3FD}')).toBe(true);
    expect(isWideChar('\u{1F1FA}\u{1F1F8}')).toBe(true);
  });

  it('leaves box-drawing and block glyphs narrow so they keep tiling', () => {
    expect(isWideChar('─')).toBe(false);
    expect(isWideChar('█')).toBe(false);
    expect(isWideChar('•')).toBe(false);
  });

  it('leaves text-presentation Dingbats narrow', () => {
    // Their glyphs sit within a cell, so isolating them buys nothing — and the
    // block contains ❯, the default zsh prompt character, which would otherwise
    // get its own span on every prompt line.
    expect(isWideChar('❯')).toBe(false);
    expect(isWideChar('❤')).toBe(false);
    expect(isWideChar('✔')).toBe(false);
  });
});

describe('sameCellStyle', () => {
  it('compares palette colours by index and RGB colours by value', () => {
    expect(sameCellColor(3, 3)).toBe(true);
    expect(sameCellColor(3, 4)).toBe(false);
    expect(sameCellColor({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 3 })).toBe(true);
    expect(sameCellColor({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 4 })).toBe(false);
    // A palette index is never the RGB it maps to, and unset is its own value.
    expect(sameCellColor(1, { r: 205, g: 0, b: 0 })).toBe(false);
    expect(sameCellColor(undefined, 0)).toBe(false);
    expect(sameCellColor(undefined, undefined)).toBe(true);
  });

  it('treats an unset attribute as false, and any other difference as a new style', () => {
    expect(sameCellStyle({ fg: 2 }, { fg: 2, bold: false, underline: false })).toBe(true);
    expect(sameCellStyle(undefined, undefined)).toBe(true);
    // Both renderers group cells by style, so an empty style and no style
    // must not be the same run as a styled one.
    expect(sameCellStyle(undefined, {})).toBe(false);
    expect(sameCellStyle({ fg: 2 }, { fg: 2, bold: true })).toBe(false);
    expect(sameCellStyle({ bg: { r: 0, g: 0, b: 0 } }, { bg: { r: 0, g: 0, b: 1 } })).toBe(false);
    expect(sameCellStyle({ url: 'https://a' }, { url: 'https://b' })).toBe(false);
  });
});
