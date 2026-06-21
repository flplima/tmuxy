import { describe, it, expect } from 'vitest';
import { detectVerticalShift } from '../scrollShift';
import type { CellLine, PaneContent } from '../../tmux/types';

function line(text: string): CellLine {
  return [...text].map((c) => ({ c }));
}
function grid(...rows: string[]): PaneContent {
  return rows.map(line);
}

const BASE = grid('row0', 'row1', 'row2', 'row3', 'row4', 'row5');

describe('detectVerticalShift', () => {
  it('returns 0 when nothing changed (reference-equal)', () => {
    expect(detectVerticalShift(BASE, BASE)).toBe(0);
  });

  it('returns 0 for two distinct, non-shifted frames', () => {
    const next = grid('row0', 'row1', 'row2', 'row3', 'row4', 'row5');
    // Same content but a different array identity and no scroll relationship
    // beyond k=0 (which is not a shift) → no animation.
    expect(detectVerticalShift(BASE, next)).toBe(0);
  });

  it('detects a log-tail scroll (content moved up by 1 → k = -1)', () => {
    const next = grid('row1', 'row2', 'row3', 'row4', 'row5', 'row6');
    expect(detectVerticalShift(BASE, next)).toBe(-1);
  });

  it('detects scroll-up into history (content moved down by 1 → k = +1)', () => {
    const next = grid('rowZ', 'row0', 'row1', 'row2', 'row3', 'row4');
    expect(detectVerticalShift(BASE, next)).toBe(1);
  });

  it('detects a multi-line upward shift (k = -3)', () => {
    const next = grid('row3', 'row4', 'row5', 'row6', 'row7', 'row8');
    expect(detectVerticalShift(BASE, next)).toBe(-3);
  });

  it('uses reference equality for unchanged lines (fast path)', () => {
    // next reuses BASE line references, shifted up by one (a log tail).
    const next: PaneContent = [BASE[1], BASE[2], BASE[3], BASE[4], BASE[5], line('row6')];
    expect(detectVerticalShift(BASE, next)).toBe(-1);
  });

  it('returns 0 for a full redraw (no overlap)', () => {
    const next = grid('qqqq', 'rrrr', 'ssss', 'tttt', 'uuuu', 'vvvv');
    expect(detectVerticalShift(BASE, next)).toBe(0);
  });

  it('returns 0 when the new frame is entirely blank', () => {
    const next = grid('', '', '', '', '', '');
    expect(detectVerticalShift(BASE, next)).toBe(0);
  });

  it('returns 0 when the row count changes substantially (layout, not scroll)', () => {
    const next = grid('row1', 'row2');
    expect(detectVerticalShift(BASE, next)).toBe(0);
  });

  it('ignores blank-on-blank rows when scoring', () => {
    // A mostly-blank screen with a couple of content lines that genuinely
    // shift up by one. Blank rows must not inflate or deflate the score.
    const prev = grid('alpha', 'bravo', 'charlie', 'delta', '', '');
    const next = grid('bravo', 'charlie', 'delta', '', '', 'echo');
    expect(detectVerticalShift(prev, next)).toBe(-1);
  });

  it('does not animate below the match-ratio threshold', () => {
    // Only one of several rows lines up as a shift; not confident enough.
    const prev = grid('aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff');
    const next = grid('bbbb', 'xxxx', 'yyyy', 'zzzz', 'wwww', 'vvvv');
    expect(detectVerticalShift(prev, next)).toBe(0);
  });

  it('prefers the smallest |k| on ambiguous repeated content', () => {
    const prev = grid('x', 'x', 'x', 'x', 'x', 'y');
    const next = grid('x', 'x', 'x', 'x', 'x', 'x');
    // Repeated rows match at several shifts; the smallest magnitude wins.
    expect(Math.abs(detectVerticalShift(prev, next))).toBe(1);
  });
});
