import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  byteString,
  CHUNK_BYTES,
  CHUNK_INTERVAL_MS,
  PacedWriter,
  SERIAL_FLUSH_MS,
  SerialCollector,
} from '../serialLink';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the guest's output", () => {
  it('crosses as one chunk per burst, however many bytes the burst has', () => {
    const chunks: Uint8Array[] = [];
    const output = new SerialCollector((chunk) => chunks.push(chunk));
    const burst = Array.from({ length: 10_000 }, (_, i) => i % 256);

    for (const byte of burst) output.push(byte);
    vi.advanceTimersByTime(SERIAL_FLUSH_MS - 1);
    expect(chunks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(chunks.map((chunk) => [...chunk])).toEqual([burst]);

    output.push(7);
    vi.advanceTimersByTime(SERIAL_FLUSH_MS);
    expect(chunks.map((chunk) => [...chunk])).toEqual([burst, [7]]);
  });

  it('is dropped, not sent, when the machine is rewound before the burst ends', () => {
    const chunks: Uint8Array[] = [];
    const output = new SerialCollector((chunk) => chunks.push(chunk));
    output.push(1);
    output.clear();
    vi.advanceTimersByTime(SERIAL_FLUSH_MS * 4);
    expect(chunks).toEqual([]);
  });
});

describe("the page's input", () => {
  it('reaches the UART a chunk at a time, every byte one char', () => {
    const writes: string[] = [];
    const input = new PacedWriter((bytes) => writes.push(bytes));
    const line = new TextEncoder().encode(`${'x'.repeat(2 * CHUNK_BYTES)}é\n`);

    input.push(line);
    expect(writes.map((w) => w.length)).toEqual([CHUNK_BYTES]);
    vi.advanceTimersByTime(CHUNK_INTERVAL_MS);
    expect(writes.map((w) => w.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES]);
    vi.advanceTimersByTime(CHUNK_INTERVAL_MS);
    expect(writes.join('')).toBe(byteString(line));
    expect(writes[2]).toBe('\xc3\xa9\n');
  });

  it('drops what is still queued when the machine is rewound', () => {
    const writes: string[] = [];
    const input = new PacedWriter((bytes) => writes.push(bytes));
    input.push(new Uint8Array(3 * CHUNK_BYTES));
    input.clear();
    vi.advanceTimersByTime(10 * CHUNK_INTERVAL_MS);
    expect(writes).toHaveLength(1);

    input.push(new TextEncoder().encode('ls\n'));
    expect(writes[writes.length - 1]).toBe('ls\n');
  });
});
