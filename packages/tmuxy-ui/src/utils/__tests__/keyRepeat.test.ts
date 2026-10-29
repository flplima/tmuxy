import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyRepeat } from '../keyRepeat';

describe('keyRepeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const presses: string[] = [];
    const repeat = createKeyRepeat((k) => presses.push(k), { delay: 350, interval: 60 });
    return { presses, repeat };
  };

  it('presses once at touch, again after the delay, then at the interval until the lift', () => {
    const { presses, repeat } = setup();
    repeat.start('ArrowUp');
    expect(presses).toEqual(['ArrowUp']);
    vi.advanceTimersByTime(349);
    expect(presses).toHaveLength(1);
    vi.advanceTimersByTime(61);
    expect(presses).toHaveLength(2);
    vi.advanceTimersByTime(180);
    expect(presses).toHaveLength(5);
    repeat.stop();
    vi.advanceTimersByTime(1000);
    expect(presses).toHaveLength(5);
    expect(repeat.current).toBeNull();
  });

  it('a slide onto another key presses it at once and repeats that one instead', () => {
    const { presses, repeat } = setup();
    repeat.start('ArrowUp');
    vi.advanceTimersByTime(100);
    repeat.slide('ArrowDown');
    expect(presses).toEqual(['ArrowUp', 'ArrowDown']);
    expect(repeat.current).toBe('ArrowDown');
    // The pause starts over for the new key: nothing from the old timers.
    vi.advanceTimersByTime(340);
    expect(presses).toHaveLength(2);
    vi.advanceTimersByTime(70);
    expect(presses).toEqual(['ArrowUp', 'ArrowDown', 'ArrowDown']);
    repeat.stop();
  });

  it('a slide off every key pauses the repeat; back onto one resumes it', () => {
    const { presses, repeat } = setup();
    repeat.start('ArrowLeft');
    repeat.slide(null);
    expect(repeat.current).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(presses).toEqual(['ArrowLeft']);
    repeat.slide('ArrowRight');
    expect(presses).toEqual(['ArrowLeft', 'ArrowRight']);
    repeat.stop();
  });

  it('staying on the same key is not a new press, and a slide after the lift does nothing', () => {
    const { presses, repeat } = setup();
    repeat.start('ArrowUp');
    repeat.slide('ArrowUp');
    expect(presses).toEqual(['ArrowUp']);
    repeat.stop();
    repeat.slide('ArrowDown');
    vi.advanceTimersByTime(1000);
    expect(presses).toEqual(['ArrowUp']);
  });
});
