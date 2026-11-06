/**
 * DECSCUSR (`CSI Ps SP q`) shape → what tmuxy draws.
 *
 * The odd shapes ask for a blinking cursor and the even ones for a steady
 * one; 0 means "whatever the terminal's default is", which for tmuxy is a
 * blinking block. Whether the blink is honoured is a separate question the
 * config's `@tmuxy-cursor-blink` answers — a steady shape is never overridden
 * into blinking, but a blinking shape is held steady when blinking is off.
 */

import { describe, it, expect } from 'vitest';
import { cursorShapeToMode } from '../cursorShape';

describe('cursorShapeToMode', () => {
  it('reads the default shape as a blinking block', () => {
    expect(cursorShapeToMode(0)).toEqual({ mode: 'block', blink: true });
  });

  it('gives every odd shape a blink and every even one a steady cursor', () => {
    expect(cursorShapeToMode(1)).toEqual({ mode: 'block', blink: true });
    expect(cursorShapeToMode(2)).toEqual({ mode: 'block', blink: false });
    expect(cursorShapeToMode(3)).toEqual({ mode: 'underline', blink: true });
    expect(cursorShapeToMode(4)).toEqual({ mode: 'underline', blink: false });
    expect(cursorShapeToMode(5)).toEqual({ mode: 'bar', blink: true });
    expect(cursorShapeToMode(6)).toEqual({ mode: 'bar', blink: false });
  });

  it('falls back to the default for a shape no terminal defines', () => {
    expect(cursorShapeToMode(7)).toEqual({ mode: 'block', blink: true });
    expect(cursorShapeToMode(-1)).toEqual({ mode: 'block', blink: true });
  });
});
