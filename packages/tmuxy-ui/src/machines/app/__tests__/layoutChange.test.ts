/**
 * Telling a resize from a swap by the boxes alone.
 *
 * This is what decides whether a geometry change animates. A swap must not:
 * animating a permutation slides the two panes through each other.
 */

import { describe, it, expect } from 'vitest';
import { isBoxPermutation, samePanes } from '../layoutChange';

const pane = (tmuxId: string, x: number, y: number, width: number, height: number) => ({
  tmuxId,
  x,
  y,
  width,
  height,
});

describe('isBoxPermutation', () => {
  it('sees a swap: the same two boxes, held by the other pane', () => {
    const before = [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 39, 20)];
    const after = [pane('%0', 41, 0, 39, 20), pane('%1', 0, 0, 40, 20)];
    expect(isBoxPermutation(before, after)).toBe(true);
  });

  it('does not see a resize as one — the boxes themselves changed', () => {
    const before = [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 39, 20)];
    const after = [pane('%0', 0, 0, 50, 20), pane('%1', 51, 0, 29, 20)];
    expect(isBoxPermutation(before, after)).toBe(false);
  });

  it('does not see a stack opening a row as one', () => {
    const before = [pane('%0', 0, 0, 80, 20), pane('%1', 0, 21, 80, 1), pane('%2', 0, 23, 80, 1)];
    const after = [pane('%0', 0, 0, 80, 1), pane('%1', 0, 2, 80, 19), pane('%2', 0, 22, 80, 1)];
    expect(isBoxPermutation(before, after)).toBe(false);
  });

  it('holds for a three-way rotation, not just a pair', () => {
    const a = pane('%0', 0, 0, 26, 20);
    const b = pane('%1', 27, 0, 26, 20);
    const c = pane('%2', 54, 0, 26, 20);
    const after = [
      { ...a, x: b.x },
      { ...b, x: c.x },
      { ...c, x: a.x },
    ];
    expect(isBoxPermutation([a, b, c], after)).toBe(true);
  });

  it('is false when a pane appeared or went away', () => {
    const before = [pane('%0', 0, 0, 80, 20)];
    const after = [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 39, 20)];
    expect(isBoxPermutation(before, after)).toBe(false);
    expect(isBoxPermutation(after, before)).toBe(false);
  });
});

describe('samePanes', () => {
  it('is true when the same ids are present, whatever their boxes', () => {
    const before = [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 39, 20)];
    const after = [pane('%1', 0, 0, 50, 20), pane('%0', 51, 0, 29, 20)];
    expect(samePanes(before, after)).toBe(true);
  });

  it('is false across a split or a kill', () => {
    expect(samePanes([pane('%0', 0, 0, 80, 20)], [])).toBe(false);
    expect(
      samePanes([pane('%0', 0, 0, 80, 20)], [pane('%0', 0, 0, 40, 20), pane('%1', 41, 0, 39, 20)]),
    ).toBe(false);
  });

  it('is false when one pane was replaced by another of the same count', () => {
    expect(samePanes([pane('%0', 0, 0, 80, 20)], [pane('%9', 0, 0, 80, 20)])).toBe(false);
  });
});
