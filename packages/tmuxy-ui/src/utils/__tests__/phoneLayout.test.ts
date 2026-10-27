import { describe, expect, it } from 'vitest';
import { PHONE_COLS, phoneCell } from '../phoneLayout';

describe('phoneCell', () => {
  it('fits 80 columns across a 390px phone, edge to edge', () => {
    // FiraCode advances 0.6px per px of font size.
    const cell = phoneCell(390, 0.6);
    expect(cell.cellWidth).toBeCloseTo(390 / 80, 10);
    expect(cell.fontSize).toBe(8.1);
    expect(cell.rowHeight).toBe(13);
  });

  it('spans the width exactly, at any width', () => {
    // A cell floored to a device pixel left up to a pixel per column unused:
    // on a 3x phone, a 26px band beside the grid.
    for (const width of [300, 351, 366, 390, 412, 590]) {
      expect(phoneCell(width, 0.6).cellWidth * PHONE_COLS).toBeCloseTo(width, 6);
    }
  });

  it('pads the font up to the cell with letter-spacing, never past it', () => {
    const cell = phoneCell(390, 0.6);
    const advance = cell.fontSize * 0.6;
    expect(advance).toBeLessThanOrEqual(cell.cellWidth);
    expect(cell.cellGap).toBeCloseTo(cell.cellWidth - advance, 10);
    expect(cell.cellGap).toBeGreaterThanOrEqual(0);
  });

  it('keeps the terminal row ratio, so a pinch zoom reads true', () => {
    // 15px type on 24px rows on the desktop: 1.6.
    const cell = phoneCell(390, 0.6);
    expect(Math.abs(cell.rowHeight / cell.fontSize - 1.6)).toBeLessThan(0.1);
  });
});
