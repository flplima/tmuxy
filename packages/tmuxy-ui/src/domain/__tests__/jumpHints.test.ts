import { describe, it, expect } from 'vitest';
import { jumpDigit, jumpHintMode, paneJumpOrder } from '../jumpHints';
import { PaneId } from '../ids';

const keys = (held: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>>) => ({
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...held,
});

describe('jumpHintMode', () => {
  it('ctrl alone numbers the tabs, ctrl+alt the panes, anything else nothing', () => {
    expect(jumpHintMode(keys({ ctrlKey: true }))).toBe('tabs');
    expect(jumpHintMode(keys({ ctrlKey: true, altKey: true }))).toBe('panes');
    expect(jumpHintMode(keys({}))).toBeNull();
    expect(jumpHintMode(keys({ altKey: true }))).toBeNull();
    expect(jumpHintMode(keys({ ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(jumpHintMode(keys({ ctrlKey: true, metaKey: true }))).toBeNull();
    // Windows reports AltGr as ctrl+alt; it types characters, it is not a jump.
    const altGr = { ...keys({ ctrlKey: true, altKey: true }), getModifierState: () => true };
    expect(jumpHintMode(altGr)).toBeNull();
  });
});

describe('jumpDigit', () => {
  it('reads 1–9 off the physical key, whatever character Option made', () => {
    expect(jumpDigit('Digit1')).toBe(1);
    expect(jumpDigit('Digit9')).toBe(9);
    expect(jumpDigit('Digit0')).toBeNull();
    expect(jumpDigit('Numpad1')).toBeNull();
    expect(jumpDigit('KeyA')).toBeNull();
  });
});

describe('paneJumpOrder', () => {
  const pane = (id: string, x: number, y: number) => ({ tmuxId: PaneId.make(id), x, y });

  it('numbers panes in reading order, top row first, left to right', () => {
    // ┌────┬────┐
    // │ %4 │ %2 │
    // ├────┼────┤
    // │ %1 │ %3 │
    // └────┴────┘
    expect(
      paneJumpOrder([pane('%1', 0, 12), pane('%2', 41, 0), pane('%3', 41, 12), pane('%4', 0, 0)]),
    ).toEqual(['%4', '%2', '%1', '%3']);
  });

  it('a tall pane on the left comes before the column beside it', () => {
    expect(paneJumpOrder([pane('%2', 41, 0), pane('%3', 41, 12), pane('%1', 0, 0)])).toEqual([
      '%1',
      '%2',
      '%3',
    ]);
  });

  it('only the first nine get a number', () => {
    const many = Array.from({ length: 12 }, (_, i) => pane(`%${i + 1}`, 0, i * 2));
    expect(paneJumpOrder(many)).toHaveLength(9);
  });
});
