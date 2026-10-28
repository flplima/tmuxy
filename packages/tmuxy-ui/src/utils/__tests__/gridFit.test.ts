import { describe, expect, it } from 'vitest';
import { fitGridCell, sameSizePolicy, type GridCell } from '../gridFit';
import type { SizePolicy } from '../../domain/wire';

// A 15px font advancing 9px, snapped to 9px cells; 24px rows.
const measured: GridCell = { charWidth: 9, charHeight: 24, cellGap: 0, gridFontSize: null };
const fixed80x25: SizePolicy = { mode: 'fixed', cols: 80, rows: 25 };

function fit(
  policy: SizePolicy,
  grid: { cols: number; rows: number },
  width: number,
  height: number,
) {
  return fitGridCell({ measured, policy, grid, container: { width, height }, fontPx: 15 });
}

describe('fitGridCell', () => {
  it('draws the measured cell under smallest, whatever the grid', () => {
    expect(fit({ mode: 'smallest' }, { cols: 300, rows: 90 }, 900, 480)).toBe(measured);
  });

  it('stretches a fixed grid to fill a container bigger than it', () => {
    // 80 × 9 = 720px of a 1440px container: twice the width, and 25 × 24 =
    // 600px of 1500px leaves room for 2.5x — the width decides.
    const cell = fit(fixed80x25, { cols: 80, rows: 25 }, 1440, 1500);
    expect(cell.charWidth).toBe(18);
    expect(cell.charHeight).toBe(48);
    expect(cell.gridFontSize).toBe(30);
    expect(80 * cell.charWidth).toBeLessThanOrEqual(1440);
    expect(25 * cell.charHeight).toBeLessThanOrEqual(1500);
  });

  it('shrinks a fixed grid into a container smaller than it, rows never overrunning', () => {
    const cell = fit(fixed80x25, { cols: 80, rows: 25 }, 2000, 300);
    expect(25 * cell.charHeight).toBeLessThanOrEqual(300);
    expect(cell.charWidth).toBeCloseTo(4.5);
    // The font and the gap still advance text by exactly one cell.
    expect(cell.gridFontSize! * (9 / 15) + cell.cellGap).toBeCloseTo(cell.charWidth);
  });

  it('shrinks a largest/latest grid that does not fit, and leaves one that does', () => {
    for (const mode of ['largest', 'latest'] as const) {
      const small = fit({ mode }, { cols: 200, rows: 20 }, 900, 480);
      expect(small.charWidth).toBeCloseTo(4.5);
      expect(fit({ mode }, { cols: 80, rows: 10 }, 900, 480)).toBe(measured);
    }
  });

  it('keeps the measured cell when the fit is within a hair of it', () => {
    expect(fit(fixed80x25, { cols: 80, rows: 25 }, 721, 601)).toBe(measured);
  });

  it('keeps the measured cell until there is a grid and a container to fit', () => {
    expect(fit(fixed80x25, { cols: 80, rows: 25 }, 0, 0)).toBe(measured);
    expect(fit({ mode: 'largest' }, { cols: 0, rows: 0 }, 900, 480)).toBe(measured);
  });
});

describe('sameSizePolicy', () => {
  it('compares modes and fixed sizes by value', () => {
    expect(sameSizePolicy({ mode: 'latest' }, { mode: 'latest' })).toBe(true);
    expect(sameSizePolicy({ mode: 'latest' }, { mode: 'largest' })).toBe(false);
    expect(sameSizePolicy(fixed80x25, { mode: 'fixed', cols: 80, rows: 25 })).toBe(true);
    expect(sameSizePolicy(fixed80x25, { mode: 'fixed', cols: 80, rows: 24 })).toBe(false);
  });
});
