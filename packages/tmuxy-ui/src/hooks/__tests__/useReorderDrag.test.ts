import { describe, it, expect } from 'vitest';
import { wid } from '../../test/wire';
import { siblingShift, type ReorderDragState } from '../useReorderDrag';

const drag = (fromIndex: number, overIndex: number): ReorderDragState => ({
  windowId: wid('@9'),
  fromIndex,
  overIndex,
  pointerId: 1,
  startX: 0,
  startY: 0,
  dx: 0,
  dy: 0,
  active: true,
  size: 80,
});

/** The shift of each of five cards, as -1 / 0 / +1. */
const shifts = (d: ReorderDragState) => [0, 1, 2, 3, 4].map((i) => siblingShift(d, i));

describe('siblingShift — the order a drop would make, shown mid-drag', () => {
  it('cards the dragged one has passed on its way right close up behind it', () => {
    // From 1, landing after the card that was at 2 (over = 2 among the others).
    expect(shifts(drag(1, 2))).toEqual([0, 0, -1, 0, 0]);
    expect(shifts(drag(1, 3))).toEqual([0, 0, -1, -1, 0]);
    expect(shifts(drag(0, 4))).toEqual([0, -1, -1, -1, -1]);
  });

  it('cards the dragged one has passed on its way left make way for it', () => {
    expect(shifts(drag(3, 1))).toEqual([0, 1, 1, 0, 0]);
    expect(shifts(drag(4, 0))).toEqual([1, 1, 1, 1, 0]);
  });

  it('a card back over its own slot moves nothing', () => {
    expect(shifts(drag(2, 2))).toEqual([0, 0, 0, 0, 0]);
  });
});
