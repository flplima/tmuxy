import { describe, expect, it } from 'vitest';
import { formatTmuxKey, keyEventInitOf } from '../keyFormatting';

/** `formatTmuxKey` of the keydown `keyEventInitOf` describes. */
const roundTrip = (name: string) =>
  formatTmuxKey(new KeyboardEvent('keydown', keyEventInitOf(name)!));

describe('keyEventInitOf', () => {
  it('describes the keydown the formatter names the same way', () => {
    for (const name of ['C-a', 'C-b', 'M-Space', 'C-M-x', 'F12', 'Escape', 'Up', 'BTab', 'a']) {
      expect(roundTrip(name)).toBe(name);
    }
  });

  it('carries the modifiers as flags and the key as the DOM names it', () => {
    expect(keyEventInitOf('C-a')).toEqual({
      key: 'a',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    });
    expect(keyEventInitOf('M-Up')).toEqual({
      key: 'ArrowUp',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    });
    expect(keyEventInitOf('BTab')).toEqual({
      key: 'Tab',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });
  });

  it('is null for a name no key produces', () => {
    expect(keyEventInitOf('NoSuchKey')).toBeNull();
    expect(keyEventInitOf('C-')).toBeNull();
  });
});
