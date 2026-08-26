import { describe, it, expect } from 'vitest';
import { isWideChar } from '../terminalShared';

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
