import { describe, it, expect } from 'vitest';
import { paletteKeyOf } from '../paletteKeys';

const NONE = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const key = (name: string, modifiers: Partial<typeof NONE> = {}) =>
  paletteKeyOf({ key: name, ...NONE, ...modifiers });

describe('paletteKeyOf', () => {
  it('closes on Escape and on the chord that opened the palette', () => {
    expect(key('Escape')).toEqual({ kind: 'close' });
    expect(key('P', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'close' });
    expect(key('P', { metaKey: true, shiftKey: true })).toEqual({ kind: 'close' });
  });

  it('runs on Enter and keeps Tab in the box', () => {
    expect(key('Enter')).toEqual({ kind: 'run' });
    expect(key('Tab')).toEqual({ kind: 'stay' });
  });

  it('steps with the arrows, Ctrl+N / Ctrl+P and Ctrl+J / Ctrl+K', () => {
    for (const down of [
      key('ArrowDown'),
      key('n', { ctrlKey: true }),
      key('j', { ctrlKey: true }),
    ]) {
      expect(down).toEqual({ kind: 'step', by: 1 });
    }
    for (const up of [key('ArrowUp'), key('p', { ctrlKey: true }), key('k', { ctrlKey: true })]) {
      expect(up).toEqual({ kind: 'step', by: -1 });
    }
  });

  it('pages with Alt and an arrow or the page keys, and jumps to an end with Cmd', () => {
    expect(key('ArrowDown', { altKey: true })).toEqual({ kind: 'page', by: 1 });
    expect(key('ArrowUp', { altKey: true })).toEqual({ kind: 'page', by: -1 });
    expect(key('PageDown')).toEqual({ kind: 'page', by: 1 });
    expect(key('PageUp')).toEqual({ kind: 'page', by: -1 });
    expect(key('ArrowDown', { metaKey: true })).toEqual({ kind: 'end', which: 'last' });
    expect(key('ArrowUp', { metaKey: true })).toEqual({ kind: 'end', which: 'first' });
  });

  it('leaves the text keys to the box', () => {
    for (const typed of [key('n'), key('j'), key('p', { shiftKey: true }), key('Backspace')]) {
      expect(typed).toBeNull();
    }
    // Ctrl+A, Ctrl+E and the rest of the box's own editing keys.
    expect(key('a', { ctrlKey: true })).toBeNull();
    expect(key('ArrowLeft')).toBeNull();
  });
});
