import { describe, expect, it } from 'vitest';
import { inGridOrder } from '../gridOrder';

describe('inGridOrder', () => {
  it('reads a grid top to bottom, then left to right along each row', () => {
    // ┌───┬───┐
    // │ a │ b │
    // ├───┴───┤
    // │   c   │
    // └───────┘  — created in the order c, b, a
    const c = { id: 'c', x: 0, y: 11 };
    const b = { id: 'b', x: 41, y: 0 };
    const a = { id: 'a', x: 0, y: 0 };
    expect(inGridOrder([c, b, a]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves its input alone', () => {
    const panes = [
      { x: 0, y: 5 },
      { x: 0, y: 0 },
    ];
    inGridOrder(panes);
    expect(panes[0].y).toBe(5);
  });
});
