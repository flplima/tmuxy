/**
 * Property tests for the delta merge.
 *
 * `applyDelta` is fed whatever the server sends, in whatever order the SSE
 * stream delivers it — including a stream that reorders, repeats or drops
 * frames. The invariant the UI depends on is structural: a pane id appears at
 * most once, because every pane keyed by that id renders one terminal. A
 * duplicate is a React key collision and two panes fighting over one grid.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { applyDelta } from '../deltaProtocol';
import type { ServerState, ServerPane, ServerWindow, ServerDelta, PaneDelta } from '../types';

const PANE_IDS = ['%1', '%2', '%3', '%4'];
const WINDOW_IDS = ['@1', '@2', '@3'];

function pane(tmuxId: string, windowId: string): ServerPane {
  return {
    id: Number(tmuxId.slice(1)),
    tmux_id: tmuxId,
    window_id: windowId,
    content: [[{ c: 'a' }]],
    cursor_x: 0,
    cursor_y: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 0,
    active: false,
    command: 'zsh',
    title: '',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
  };
}

function window(id: string): ServerWindow {
  return { id, index: Number(id.slice(1)), name: id, active: false };
}

const arbPaneDelta: fc.Arbitrary<PaneDelta> = fc.record(
  {
    window_id: fc.constantFrom(...WINDOW_IDS),
    cursor_x: fc.nat(200),
    active: fc.boolean(),
    history_size: fc.nat(10_000),
  },
  { requiredKeys: [] },
);

/** A delta that may add, update or remove any pane or window. */
const arbDelta: fc.Arbitrary<ServerDelta> = fc
  .record(
    {
      seq: fc.nat(1000),
      panes: fc.dictionary(fc.constantFrom(...PANE_IDS), fc.oneof(arbPaneDelta, fc.constant(null))),
      windows: fc.dictionary(
        fc.constantFrom(...WINDOW_IDS),
        fc.oneof(fc.record({ name: fc.string() }), fc.constant(null)),
      ),
      new_panes: fc.uniqueArray(fc.constantFrom(...PANE_IDS), { maxLength: 4 }),
      new_windows: fc.uniqueArray(fc.constantFrom(...WINDOW_IDS), { maxLength: 3 }),
      active_pane_id: fc.constantFrom(...PANE_IDS),
    },
    { requiredKeys: ['seq'] },
  )
  .map((d) => ({
    ...d,
    new_panes: d.new_panes?.map((id) => pane(id, WINDOW_IDS[0])),
    new_windows: d.new_windows?.map(window),
  })) as fc.Arbitrary<ServerDelta>;

const arbState: fc.Arbitrary<ServerState> = fc
  .record({
    panes: fc.uniqueArray(fc.constantFrom(...PANE_IDS), { maxLength: 4 }),
    windows: fc.uniqueArray(fc.constantFrom(...WINDOW_IDS), { minLength: 1, maxLength: 3 }),
  })
  .map(({ panes, windows }) => ({
    session_name: 'tmuxy',
    active_window_id: windows[0],
    active_pane_id: panes[0] ?? null,
    panes: panes.map((id) => pane(id, windows[0])),
    windows: windows.map(window),
    total_width: 80,
    total_height: 24,
    status_line: '',
  }));

describe('applyDelta properties', () => {
  it('never produces a duplicate pane or window id, whatever the delta sequence', () => {
    fc.assert(
      fc.property(arbState, fc.array(arbDelta, { maxLength: 12 }), (initial, deltas) => {
        let state = initial;
        for (const delta of deltas) {
          state = applyDelta(state, delta);
          const paneIds = state.panes.map((p) => p.tmux_id);
          expect(new Set(paneIds).size).toBe(paneIds.length);
          const windowIds = state.windows.map((w) => w.id);
          expect(new Set(windowIds).size).toBe(windowIds.length);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('only ever contains panes the stream introduced', () => {
    fc.assert(
      fc.property(arbState, fc.array(arbDelta, { maxLength: 8 }), (initial, deltas) => {
        const known = new Set(initial.panes.map((p) => p.tmux_id));
        let state = initial;
        for (const delta of deltas) {
          for (const p of delta.new_panes ?? []) known.add(p.tmux_id);
          state = applyDelta(state, delta);
          for (const p of state.panes) {
            expect(known.has(p.tmux_id)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('removes exactly the panes the delta nulls out', () => {
    fc.assert(
      fc.property(arbState, arbDelta, (initial, delta) => {
        const removed = Object.entries(delta.panes ?? {})
          .filter(([, d]) => d === null)
          .map(([id]) => id);
        const readded = new Set((delta.new_panes ?? []).map((p) => p.tmux_id));
        const after = applyDelta(initial, delta).panes.map((p) => p.tmux_id);
        for (const id of removed) {
          if (!readded.has(id)) expect(after).not.toContain(id);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never mutates the state it was given', () => {
    fc.assert(
      fc.property(arbState, arbDelta, (initial, delta) => {
        const snapshot = JSON.stringify(initial);
        applyDelta(initial, delta);
        expect(JSON.stringify(initial)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });
});
