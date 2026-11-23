import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSerialPump } from '../v86Guest';

const TEXT = 'ok 日本語 🎉 end';
const BYTES = [...new TextEncoder().encode(TEXT)];

describe('createSerialPump', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delivers one receive per burst and keeps a character split across flushes', () => {
    const received: string[] = [];
    const pump = createSerialPump((t) => received.push(t));
    const emoji = BYTES.indexOf(0xf0);

    BYTES.slice(0, emoji + 2).forEach(pump.push);
    vi.advanceTimersByTime(8);
    BYTES.slice(emoji + 2).forEach(pump.push);
    vi.advanceTimersByTime(8);

    expect(received).toHaveLength(2);
    expect(received.join('')).toBe(TEXT);
  });

  it('does not carry half a character from a reset stream into the next', () => {
    const received: string[] = [];
    const pump = createSerialPump((t) => received.push(t));
    const emoji = BYTES.indexOf(0xf0);

    BYTES.slice(0, emoji + 2).forEach(pump.push);
    vi.advanceTimersByTime(8);
    pump.reset();
    'abc'.split('').forEach((c) => pump.push(c.charCodeAt(0)));
    vi.advanceTimersByTime(8);

    expect(received[received.length - 1]).toBe('abc');
  });

  it('grows past its initial buffer', () => {
    const received: string[] = [];
    const pump = createSerialPump((t) => received.push(t));
    for (let i = 0; i < 10000; i++) pump.push(65);
    vi.advanceTimersByTime(8);
    expect(received).toEqual(['A'.repeat(10000)]);
  });
});
