import { describe, expect, it } from 'vitest';
import { fitScale, glyphFit, needsMeasure } from '../glyphFit';

describe('fitScale', () => {
  it('leaves glyphs that fit their cell alone, within tolerance', () => {
    expect(fitScale(1)).toBeNull();
    expect(fitScale(0.98)).toBeNull();
    expect(fitScale(1.1)).toBeNull();
  });

  it('shrinks a fat glyph into one cell', () => {
    expect(fitScale(1.6)).toBeCloseTo(1 / 1.6, 6);
    expect(fitScale(2)).toBe(0.5);
  });
});

describe('needsMeasure', () => {
  it("skips ASCII, which is the font's own and the hot path", () => {
    expect(needsMeasure('a')).toBe(false);
    expect(needsMeasure('~')).toBe(false);
    expect(needsMeasure('')).toBe(false);
  });

  it('considers everything else, because everything else can come from a fallback font', () => {
    expect(needsMeasure('❯')).toBe(true);
    expect(needsMeasure('⎿')).toBe(true);
    // Latin Extended looks ordinary and is exactly where a fallback hides.
    expect(needsMeasure('é')).toBe(true);
    expect(needsMeasure('ơ')).toBe(true);
    expect(needsMeasure('ș')).toBe(true);
  });
});

describe('glyphFit', () => {
  it('returns null without layout (jsdom) rather than caching a bogus ratio', () => {
    expect(glyphFit('⎿')).toBeNull();
    expect(glyphFit('a')).toBeNull();
  });
});
