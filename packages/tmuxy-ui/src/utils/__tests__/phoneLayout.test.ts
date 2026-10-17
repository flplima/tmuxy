import { describe, expect, it } from 'vitest';
import { PHONE_COLS, phoneCell } from '../phoneLayout';

describe('phoneCell', () => {
  it('fits 80 columns into a 390px phone at its device pixel ratio', () => {
    // 390 less the container's 12px margins; FiraCode advances 0.6px per px.
    const cell = phoneCell(366, 0.6, 3);
    expect(cell.cellWidth).toBeCloseTo(13 / 3, 10);
    expect(cell.cellWidth * PHONE_COLS).toBeLessThanOrEqual(366);
    expect(cell.fontSize).toBe(7.2);
    expect(cell.rowHeight).toBe(12);
  });

  it('never overflows: the width floors to a device pixel', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const width of [300, 351, 366, 412, 590]) {
        expect(phoneCell(width, 0.6, dpr).cellWidth * PHONE_COLS).toBeLessThanOrEqual(width);
      }
    }
  });

  it('pads the font up to the cell with letter-spacing, never past it', () => {
    const cell = phoneCell(366, 0.6, 2);
    const advance = cell.fontSize * 0.6;
    expect(advance).toBeLessThanOrEqual(cell.cellWidth);
    expect(cell.cellGap).toBeCloseTo(cell.cellWidth - advance, 10);
    expect(cell.cellGap).toBeGreaterThanOrEqual(0);
  });

  it('keeps the terminal row ratio, so a pinch zoom reads true', () => {
    // 15px type on 24px rows on the desktop: 1.6.
    const cell = phoneCell(366, 0.6, 3);
    expect(Math.abs(cell.rowHeight / cell.fontSize - 1.6)).toBeLessThan(0.1);
  });
});
