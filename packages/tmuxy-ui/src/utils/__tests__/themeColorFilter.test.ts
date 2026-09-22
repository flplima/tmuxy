import { describe, it, expect } from 'vitest';
import { luminance, parseRgb, rampTables, sortByTone, themeFilterId } from '../themeColorFilter';

describe('rampTables', () => {
  it('lays one stop per theme colour on each channel, in the order given', () => {
    // gruvbox dark, darkest first: background, gray, foreground.
    const tables = rampTables([
      { r: 40, g: 40, b: 40 },
      { r: 146, g: 131, b: 116 },
      { r: 235, g: 219, b: 178 },
    ]);
    expect(tables.r.split(' ').map(Number)).toEqual([
      Number((40 / 255).toFixed(4)),
      Number((146 / 255).toFixed(4)),
      Number((235 / 255).toFixed(4)),
    ]);
    expect(tables.g.split(' ')).toHaveLength(3);
    expect(tables.b.split(' ')).toHaveLength(3);
  });

  it('writes the channel ends as 0 and 1', () => {
    const tables = rampTables([
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ]);
    expect(tables).toEqual({ r: '0 1', g: '0 1', b: '0 1' });
  });
});

describe('parseRgb', () => {
  it('reads the colours getComputedStyle hands back', () => {
    expect(parseRgb('rgb(40, 40, 40)')).toEqual({ r: 40, g: 40, b: 40 });
    expect(parseRgb('rgba(235, 219, 178, 0.5)')).toEqual({ r: 235, g: 219, b: 178 });
    expect(parseRgb('transparent')).toBeNull();
  });
});

describe('themeFilterId', () => {
  it('drops what url(#…) cannot hold, like the % of a pane id', () => {
    expect(themeFilterId('%12')).toBe('tmuxy-theme-filter-12');
  });
});

describe('sortByTone', () => {
  // The ramp has to preserve a page's polarity: full black in a page lands on
  // the theme's DARKEST tone, whichever variable that happens to be.
  const gruvboxDark = [
    { r: 235, g: 219, b: 178 }, // foreground
    { r: 146, g: 131, b: 116 }, // gray
    { r: 40, g: 40, b: 40 }, // background
  ];
  const gruvboxLight = [
    { r: 60, g: 56, b: 54 }, // foreground
    { r: 146, g: 131, b: 116 }, // gray
    { r: 251, g: 241, b: 199 }, // background
  ];

  it('puts the background first on a DARK theme, so black stays dark', () => {
    const ramp = sortByTone(gruvboxDark);
    expect(ramp[0]).toEqual({ r: 40, g: 40, b: 40 });
    expect(ramp[2]).toEqual({ r: 235, g: 219, b: 178 });
  });

  it('puts the FOREGROUND first on a light theme, where the roles swap', () => {
    // One rule covers both, which is the point of ordering by tone rather
    // than naming one variable "the dark end".
    const ramp = sortByTone(gruvboxLight);
    expect(ramp[0]).toEqual({ r: 60, g: 56, b: 54 });
    expect(ramp[2]).toEqual({ r: 251, g: 241, b: 199 });
  });

  it("leaves the caller's array alone", () => {
    const stops = [...gruvboxDark];
    sortByTone(stops);
    expect(stops).toEqual(gruvboxDark);
  });
});

describe('luminance', () => {
  it("weights the channels the way the filter's own colour matrix does", () => {
    expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(255, 3);
    // Green carries most of the weight, blue least — Rec. 709.
    expect(luminance({ r: 0, g: 255, b: 0 })).toBeGreaterThan(luminance({ r: 255, g: 0, b: 0 }));
    expect(luminance({ r: 255, g: 0, b: 0 })).toBeGreaterThan(luminance({ r: 0, g: 0, b: 255 }));
  });
});
