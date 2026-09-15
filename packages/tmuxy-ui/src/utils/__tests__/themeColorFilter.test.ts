import { describe, it, expect } from 'vitest';
import { parseRgb, rampTables, themeFilterId } from '../themeColorFilter';

describe('rampTables', () => {
  it('lays one stop per theme colour on each channel, dark ink first', () => {
    // gruvbox dark: foreground, gray, background.
    const tables = rampTables([
      { r: 235, g: 219, b: 178 },
      { r: 146, g: 131, b: 116 },
      { r: 40, g: 40, b: 40 },
    ]);
    expect(tables.r.split(' ').map(Number)).toEqual([
      Number((235 / 255).toFixed(4)),
      Number((146 / 255).toFixed(4)),
      Number((40 / 255).toFixed(4)),
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
