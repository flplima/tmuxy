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
  it('skips ordinary text and considers symbols only', () => {
    expect(needsMeasure('a')).toBe(false);
    expect(needsMeasure('é')).toBe(false);
    expect(needsMeasure('❯')).toBe(true);
    expect(needsMeasure('⎿')).toBe(true);
    expect(needsMeasure('')).toBe(false);
  });
});

describe('glyphFit', () => {
  it('returns null without layout (jsdom) rather than caching a bogus ratio', () => {
    expect(glyphFit('⎿')).toBeNull();
    expect(glyphFit('a')).toBeNull();
  });
});
