import { describe, it, expect } from 'vitest';
import { snapCellWidth, computeCellMetrics, cellMetricsStyle } from '../cellMetrics';
import { cellsToCss } from '../../components/terminalShared';

describe('snapCellWidth', () => {
  it('rounds a fractional advance to a whole CSS pixel at DPR 1', () => {
    expect(snapCellWidth(8.4, 1)).toBe(8);
    expect(snapCellWidth(8.6, 1)).toBe(9);
    expect(snapCellWidth(9, 1)).toBe(9);
  });

  it('rounds to a whole DEVICE pixel at higher / fractional DPRs', () => {
    // 8.4 css px = 16.8 device px → 17 device px = 8.5 css px
    expect(snapCellWidth(8.4, 2)).toBe(8.5);
    // 7.8 css px = 11.7 device px → 12 device px = 8 css px
    expect(snapCellWidth(7.8, 1.5)).toBe(8);
    // 9.02 css px = 11.275 device px → 11 device px = 8.8 css px
    expect(snapCellWidth(9.02, 1.25)).toBeCloseTo(8.8, 10);
  });

  it('never collapses the grid to zero on a degenerate measurement', () => {
    expect(snapCellWidth(0.2, 1)).toBe(0.2);
    expect(snapCellWidth(8.4, 0)).toBe(8);
  });
});

describe('computeCellMetrics', () => {
  it('derives the letter-spacing that pads the advance up to the snapped cell', () => {
    const m = computeCellMetrics(8.4, 1);
    expect(m).toEqual({ advance: 8.4, cellWidth: 8, cellGap: 8 - 8.4 });
    expect(computeCellMetrics(8.6, 1).cellGap).toBeCloseTo(0.4, 10);
    // Already whole: nothing to pad.
    expect(computeCellMetrics(9, 1).cellGap).toBe(0);
  });
});

describe('cellMetricsStyle / cellsToCss', () => {
  it('publishes --cell-w / --cell-gap and every cell length resolves against --cell-w', () => {
    expect(cellMetricsStyle({ cellWidth: 9, cellGap: -0.2 })).toEqual({
      '--cell-w': '9px',
      '--cell-gap': '-0.2px',
    });
    expect(cellsToCss(11)).toBe('calc(11 * var(--cell-w, 1ch))');
  });
});
