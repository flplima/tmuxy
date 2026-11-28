import { describe, expect, it } from 'vitest';
import { SHEET_FLICK_DISTANCE, SHEET_FLICK_SPEED, sheetCloses } from '../sheetSwipe';

describe('sheetCloses — a sheet dragged down by its bar', () => {
  const height = 800;

  it('closes past a quarter of its height, however slowly', () => {
    expect(sheetCloses(200, 0, height)).toBe(true);
    expect(sheetCloses(199, 0, height)).toBe(false);
  });

  it('closes on a flick down once it has come far enough', () => {
    expect(sheetCloses(SHEET_FLICK_DISTANCE, SHEET_FLICK_SPEED, height)).toBe(true);
    expect(sheetCloses(SHEET_FLICK_DISTANCE - 1, SHEET_FLICK_SPEED * 4, height)).toBe(false);
    expect(sheetCloses(SHEET_FLICK_DISTANCE, SHEET_FLICK_SPEED / 2, height)).toBe(false);
  });

  it('never closes when pulled up or not at all', () => {
    expect(sheetCloses(0, 5, height)).toBe(false);
    expect(sheetCloses(-300, 5, height)).toBe(false);
  });
});
