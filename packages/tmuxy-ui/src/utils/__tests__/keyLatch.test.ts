import { afterEach, describe, expect, it } from 'vitest';
import {
  getLatches,
  pressKey,
  resetLatches,
  subscribeLatches,
  takeModifiers,
  tapModifier,
} from '../keyLatch';

afterEach(resetLatches);

describe('keyLatch', () => {
  it('a tap latches, a second locks, a third lets go', () => {
    tapModifier('ctrl');
    expect(getLatches().ctrl).toBe('latched');
    tapModifier('ctrl');
    expect(getLatches().ctrl).toBe('locked');
    tapModifier('ctrl');
    expect(getLatches().ctrl).toBe('off');
  });

  it('the next key takes a latch with it, and leaves a lock', () => {
    expect(takeModifiers()).toBeNull();

    tapModifier('ctrl');
    tapModifier('alt');
    tapModifier('alt');
    expect(takeModifiers()).toEqual({ ctrlKey: true, altKey: true });
    expect(getLatches()).toEqual({ ctrl: 'off', alt: 'locked' });
    expect(takeModifiers()).toEqual({ ctrlKey: false, altKey: true });
  });

  it('presses the key on the window, carrying the latch, and tells the key row', () => {
    const seen: KeyboardEvent[] = [];
    const listen = (e: KeyboardEvent) => seen.push(e);
    window.addEventListener('keydown', listen);
    let notified = 0;
    const unsubscribe = subscribeLatches(() => notified++);
    try {
      tapModifier('ctrl');
      pressKey('c');
      pressKey('Escape');
    } finally {
      window.removeEventListener('keydown', listen);
      unsubscribe();
    }
    expect(seen.map((e) => [e.key, e.ctrlKey])).toEqual([
      ['c', true],
      ['Escape', false],
    ]);
    // Latched, then let go: the row redraws both times.
    expect(notified).toBe(2);
  });
});
