import { describe, expect, it } from 'vitest';
import { slideMode } from '../useSheetScroll';

describe('slideMode — a finger’s first slide on the compose sheet’s text box', () => {
  const from = { x: 100, y: 100, at: 0 };
  const to = (dx: number, dy: number, at = 60) => ({ x: 100 + dx, y: 100 + dy, at });

  it('is undecided until the finger has moved a few pixels', () => {
    expect(slideMode(from, to(3, 5), true)).toBe('undecided');
  });

  it('pulls the sheet when it goes down quickly, with the text at its top', () => {
    expect(slideMode(from, to(2, 12), true)).toBe('pull');
  });

  it('is anything but a pull up, sideways, after a rest, or with text above', () => {
    expect(slideMode(from, to(0, -12), true)).toBe('other');
    expect(slideMode(from, to(14, 10), true)).toBe('other');
    expect(slideMode(from, to(0, 12, 600), true)).toBe('other');
    expect(slideMode(from, to(0, 12), false)).toBe('other');
  });
});
