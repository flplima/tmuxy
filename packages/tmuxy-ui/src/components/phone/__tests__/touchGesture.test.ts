import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_MS,
  decideIntent,
  isDoubleTap,
  isTap,
  releaseSpeed,
  TAP_SLOP_PX,
} from '../touchGesture';

const at = (x: number, y: number, t = 0) => ({ x, y, t });

describe('decideIntent', () => {
  it('stays undecided inside the slop', () => {
    expect(decideIntent(at(100, 100), at(105, 104), true)).toBe('undecided');
  });

  it('is a slide when the travel is mostly sideways and slides are allowed', () => {
    expect(decideIntent(at(100, 100), at(140, 108), true)).toBe('swipe');
    // The same travel with slides off scrolls.
    expect(decideIntent(at(100, 100), at(140, 108), false)).toBe('scroll');
  });

  it('scrolls on a vertical or diagonal travel', () => {
    expect(decideIntent(at(100, 100), at(102, 140), true)).toBe('scroll');
    expect(decideIntent(at(100, 100), at(120, 118), true)).toBe('scroll');
  });
});

describe('isTap and isDoubleTap', () => {
  it('a lift inside the slop is a tap, outside it is not', () => {
    expect(isTap(at(10, 10), at(10 + TAP_SLOP_PX - 1, 10))).toBe(true);
    expect(isTap(at(10, 10), at(10 + TAP_SLOP_PX, 10))).toBe(false);
  });

  it('two taps close in time and space are a double tap', () => {
    expect(isDoubleTap(at(10, 10, 0), at(20, 15, DOUBLE_TAP_MS))).toBe(true);
    expect(isDoubleTap(at(10, 10, 0), at(20, 15, DOUBLE_TAP_MS + 1))).toBe(false);
    expect(isDoubleTap(at(10, 10, 0), at(60, 15, 100))).toBe(false);
    expect(isDoubleTap(null, at(10, 10, 100))).toBe(false);
  });
});

describe('releaseSpeed', () => {
  it('is the sideways speed over the sample window, zero with nothing to measure', () => {
    expect(releaseSpeed([at(0, 0, 0), at(50, 0, 50), at(100, 0, 100)])).toBe(1);
    expect(releaseSpeed([at(100, 0, 0), at(60, 0, 80)])).toBe(-0.5);
    expect(releaseSpeed([at(0, 0, 0)])).toBe(0);
    expect(releaseSpeed([at(0, 0, 5), at(10, 0, 5)])).toBe(0);
  });
});
