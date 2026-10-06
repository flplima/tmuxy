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

const COLS = 200;
const ROWS = 60;
const PANES = 4;

function row(y: number): unknown[] {
  return Array.from({ length: COLS }, (_, x) =>
    x % 7 === 0 ? { c: 'x', s: { fg: (x + y) % 256, bold: true } } : { c: 'a' },
  );
}

function pane(n: number, rows: number): Record<string, unknown> {
  return {
    id: n,
    tmux_id: `%${n}`,
    window_id: '@1',
    content: Array.from({ length: rows }, (_, y) => row(y)),
    cursor_x: 3,
    cursor_y: 4,
    width: COLS,
    height: rows,
    x: 0,
    y: 0,
    active: n === 0,
    command: 'zsh',
    title: 'host',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
    alternate_on: false,
    mouse_any_flag: false,
    paused: false,
    history_size: 2000,
    selection_present: false,
    selection_start_x: 0,
    selection_start_y: 0,
    cursor_shape: 0,
    cursor_hidden: false,
  };
}

function fullUpdate(rows: number): unknown {
  return {
    type: 'full',
    state: {
      session_name: 'tmuxy',
      active_window_id: '@1',
      active_pane_id: '%0',
      panes: Array.from({ length: PANES }, (_, n) => pane(n, rows)),
      windows: [
        { id: '@1', index: 1, name: 'main', active: true, window_type: 'tab' },
        { id: '@2', index: 2, name: 'logs', active: false, window_type: 'tab' },
      ],
      total_width: COLS,
      total_height: rows,
    },
  };
}

/** A keystroke's echo: two changed rows and the cursor of one pane. */
const typicalDelta: unknown = {
  type: 'delta',
  delta: {
    seq: 42,
    panes: { '%0': { content: { 10: row(10), 11: row(11) }, cursor_x: 12, cursor_y: 11 } },
  },
};

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
    const delta = measure(typicalDelta, 2000);
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
