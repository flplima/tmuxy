/**
 * What decoding at the boundary costs on the hot path.
 *
 * Every `state-update` is decoded before it is applied. A full state carries
 * every cell of every pane, so the cell grid is checked for its outer shape
 * only (`PaneContent` in `domain/wire.ts`); this measures that the decode stays
 * well inside a frame for a realistic session and a typical delta, and that
 * its cost does not grow with the number of cells.
 */

import { describe, it, expect } from 'vitest';
import { Either } from 'effect';
import { decodeStateUpdate } from '../wireDecode';
import { toClientState } from '../../domain/client';
import { COLS, PANES, ROWS, fullUpdate, typicalDelta } from '../../test/benchFixtures';

const typical = typicalDelta(42);

/** Mean milliseconds per decode of `payload`. */
function measure(payload: unknown, iterations: number): number {
  for (let i = 0; i < 20; i++) decodeStateUpdate(payload);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    if (Either.isLeft(decodeStateUpdate(payload))) throw new Error('fixture did not decode');
  }
  return (performance.now() - start) / iterations;
}

/** Mean milliseconds to derive the client model from a decoded full state. */
function measureClient(payload: unknown, iterations: number): number {
  const decoded = decodeStateUpdate(payload);
  if (Either.isLeft(decoded) || decoded.right.type !== 'full') throw new Error('not a full state');
  const state = decoded.right.state;
  for (let i = 0; i < 20; i++) toClientState(state);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) toClientState(state);
  return (performance.now() - start) / iterations;
}

describe('state-update decode cost', () => {
  it('decodes a full 4-pane 200x60 state and a typical delta well inside a frame', () => {
    const full = measure(fullUpdate(ROWS), 200);
    const tiny = measure(fullUpdate(1), 200);
    const delta = measure(typical, 2000);
    const client = measureClient(fullUpdate(ROWS), 200);
    console.info(
      `[wire decode] full ${PANES}x${COLS}x${ROWS}: ${(full * 1000).toFixed(1)}µs, ` +
        `full ${PANES}x${COLS}x1: ${(tiny * 1000).toFixed(1)}µs, delta: ${(delta * 1000).toFixed(1)}µs, ` +
        `client model from full: ${(client * 1000).toFixed(1)}µs`,
    );
    // The budget for a full state; the measured cost is a small fraction of it.
    expect(full).toBeLessThan(2);
    expect(delta).toBeLessThan(2);
    expect(client).toBeLessThan(2);
  });
});
