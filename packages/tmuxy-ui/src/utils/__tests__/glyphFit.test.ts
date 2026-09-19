import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('glyphFit with settled fonts and ink the canvas cannot answer for', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'fonts');
    vi.resetModules();
  });

  it('measures the glyph once and never asks everything to redraw by itself', async () => {
    // Fonts have settled (`ready` is resolved, nothing is loading) and the
    // face covering the glyph is not among them, so `check` stays false.
    const load = vi.fn(() => Promise.resolve([]));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        status: 'loaded',
        ready: Promise.resolve(),
        check: () => false,
        load,
        addEventListener: () => {},
      },
    });
    // A one-cell advance: not fat on its own, so only the ink could say more.
    const layout = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 100 } as DOMRect);
    vi.resetModules();
    const fit = await import('../glyphFit');
    const redraw = vi.fn();
    fit.subscribeGlyphFit(redraw);

    // A screenful of the same symbol, drawn over several renders.
    for (let render = 0; render < 5; render++) {
      for (let cell = 0; cell < 50; cell++) expect(fit.glyphFit('●')).toBeNull();
      await Promise.resolve();
    }

    // Two layout reads for the one probe — not two per cell per render.
    expect(layout).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(1);
    // The regression: a resolved `fonts.ready` cleared the cache and told every
    // terminal to redraw, which measured again and asked again, without end.
    expect(redraw).not.toHaveBeenCalled();
  });
});
