import { describe, it, expect } from 'vitest';
import { rectOverlapArea, findEnterFromBox, findLeaveToBox } from '../paneTransitions';
import type { PaneBox } from '../../constants';

const box = (left: number, top: number, width: number, height: number): PaneBox => ({
  left,
  top,
  width,
  height,
});

describe('rectOverlapArea', () => {
  it('returns the intersection area of overlapping rects', () => {
    expect(rectOverlapArea(box(0, 0, 100, 100), box(50, 50, 100, 100))).toBe(2500);
  });

  it('returns 0 for disjoint and edge-touching rects', () => {
    expect(rectOverlapArea(box(0, 0, 100, 100), box(200, 0, 50, 50))).toBe(0);
    expect(rectOverlapArea(box(0, 0, 100, 100), box(100, 0, 50, 100))).toBe(0);
  });
});

describe('findEnterFromBox', () => {
  it('finds the shrunken split source for a vertical split (side by side)', () => {
    // Pane A was full width (0..800), split: A now left half, B right half.
    const aOld = box(0, 0, 800, 600);
    const aNew = box(0, 0, 400, 600);
    const bNew = box(400, 0, 400, 600);
    const prev = new Map([['A', aOld]]);
    const curr = new Map([
      ['A', aNew],
      ['B', bNew],
    ]);
    expect(findEnterFromBox(bNew, prev, curr)).toEqual(aOld);
  });

  it('finds the shrunken split source for a horizontal split (stacked)', () => {
    const aOld = box(0, 0, 800, 600);
    const aNew = box(0, 0, 800, 300);
    const bNew = box(0, 300, 800, 300);
    const prev = new Map([['A', aOld]]);
    const curr = new Map([
      ['A', aNew],
      ['B', bNew],
    ]);
    expect(findEnterFromBox(bNew, prev, curr)).toEqual(aOld);
  });

  it('picks the source among multiple panes, ignoring unchanged ones', () => {
    // Two columns; the right one (A) splits into A + B stacked.
    const leftCol = box(0, 0, 400, 600);
    const aOld = box(400, 0, 400, 600);
    const aNew = box(400, 0, 400, 300);
    const bNew = box(400, 300, 400, 300);
    const prev = new Map([
      ['L', leftCol],
      ['A', aOld],
    ]);
    const curr = new Map([
      ['L', leftCol],
      ['A', aNew],
      ['B', bNew],
    ]);
    expect(findEnterFromBox(bNew, prev, curr)).toEqual(aOld);
  });

  it('returns null when no surviving pane changed (new window pane)', () => {
    const only = box(0, 0, 800, 600);
    const prev = new Map([['A', only]]);
    const curr = new Map([
      ['A', only],
      ['B', box(0, 0, 800, 600)],
    ]);
    expect(findEnterFromBox(box(0, 0, 800, 600), prev, curr)).toBeNull();
  });

  it('rejects candidates overlapping less than half the new box', () => {
    // A pane elsewhere resized slightly but barely overlaps the new pane.
    const cOld = box(0, 0, 220, 600);
    const cNew = box(0, 0, 200, 600);
    const bNew = box(200, 0, 600, 600);
    const prev = new Map([['C', cOld]]);
    const curr = new Map([
      ['C', cNew],
      ['B', bNew],
    ]);
    expect(findEnterFromBox(bNew, prev, curr)).toBeNull();
  });
});

describe('findLeaveToBox', () => {
  it('finds the expanded absorber for a killed pane', () => {
    // B (right half) killed; A expands to full width.
    const aOld = box(0, 0, 400, 600);
    const bOld = box(400, 0, 400, 600);
    const aNew = box(0, 0, 800, 600);
    const prev = new Map([
      ['A', aOld],
      ['B', bOld],
    ]);
    const curr = new Map([['A', aNew]]);
    expect(findLeaveToBox(bOld, prev, curr)).toEqual(aNew);
  });

  it('picks the absorber among several survivors', () => {
    // Three stacked panes; middle killed, top absorbs the space.
    const topOld = box(0, 0, 800, 200);
    const midOld = box(0, 200, 800, 200);
    const botOld = box(0, 400, 800, 200);
    const topNew = box(0, 0, 800, 400);
    const prev = new Map([
      ['T', topOld],
      ['M', midOld],
      ['B', botOld],
    ]);
    const curr = new Map([
      ['T', topNew],
      ['B', botOld],
    ]);
    expect(findLeaveToBox(midOld, prev, curr)).toEqual(topNew);
  });

  it('returns null when no survivor grew into the freed area', () => {
    const aOld = box(0, 0, 400, 600);
    const bOld = box(400, 0, 400, 600);
    const prev = new Map([
      ['A', aOld],
      ['B', bOld],
    ]);
    const curr = new Map([['A', aOld]]);
    expect(findLeaveToBox(bOld, prev, curr)).toBeNull();
  });
});
