import { describe, expect, it } from 'vitest';
import {
  PHONE_COLS,
  PHONE_SIDE_MIN,
  PHONE_STATUS_HEIGHT,
  phoneCell,
  phoneLandscapeCell,
} from '../phoneLayout';
import { PHONE_CONTAINER_PADDING } from '../../constants/layout';

/** Under the grid sideways: the status line and the container's padding. */
const CHROME = PHONE_STATUS_HEIGHT + PHONE_CONTAINER_PADDING;

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

describe('phoneLandscapeCell', () => {
  it('fits 24 rows and the status line into the height of a phone held sideways', () => {
    const cell = phoneLandscapeCell(844, 390, 0.6);
    expect(cell.rowHeight * 24 + CHROME).toBeLessThanOrEqual(390);
    expect(cell.rowHeight * 24 + CHROME).toBeGreaterThan(390 - 25);
    expect(cell.cellWidth).toBeCloseTo(cell.fontSize * 0.6, 10);
    expect(cell.cellGap).toBe(0);
    // The column beside the terminal keeps room for the keys and the tree.
    expect(844 - cell.cellWidth * PHONE_COLS - 2 * PHONE_CONTAINER_PADDING).toBeGreaterThanOrEqual(
      PHONE_SIDE_MIN,
    );
  });

  it('cuts to the width instead when the height would leave the side too narrow', () => {
    const cell = phoneLandscapeCell(640, 390, 0.6);
    expect(cell.cellWidth * PHONE_COLS).toBeCloseTo(
      640 - PHONE_SIDE_MIN - 2 * PHONE_CONTAINER_PADDING,
      6,
    );
    expect(cell.rowHeight * 24 + CHROME).toBeLessThanOrEqual(390);
  });
});
