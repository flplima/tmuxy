import { describe, test, expect } from 'vitest';
import { handleStateUpdate, applyDelta, isDeltaSeqGap } from '../deltaProtocol';
import type { ServerState, ServerPane, ServerDelta, StateUpdate } from '../types';

describe('isDeltaSeqGap', () => {
  const delta = (seq: number): ServerDelta => ({ seq });

  test('no gap right after a full state (null prevSeq)', () => {
    expect(isDeltaSeqGap(null, delta(7))).toBe(false);
  });

  test('no gap when seq advances by exactly one', () => {
    expect(isDeltaSeqGap(5, delta(6))).toBe(false);
  });

  test('gap when a delta is dropped', () => {
    expect(isDeltaSeqGap(5, delta(7))).toBe(true);
  });

  test('gap when seq goes backwards or repeats', () => {
    expect(isDeltaSeqGap(5, delta(5))).toBe(true);
    expect(isDeltaSeqGap(5, delta(4))).toBe(true);
  });
});

function makePane(overrides: Partial<ServerPane> = {}): ServerPane {
  return {
    id: 0,
    tmux_id: '%0',
    window_id: '@0',
    content: [],
    cursor_x: 0,
    cursor_y: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 0,
    active: true,
    command: 'zsh',
    title: '',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    session_name: 'test',
    active_window_id: '@0',
    active_pane_id: '%0',
    panes: [makePane()],
    windows: [{ id: '@0', index: 1, name: 'test', active: true, window_type: 'tab' }],
    total_width: 80,
    total_height: 24,
    status_line: '',
    ...overrides,
  };
}

const nonEmptyContent = [[{ c: 'h' }, { c: 'e' }, { c: 'l' }, { c: 'l' }, { c: 'o' }]];
const emptyContent = [[{ c: ' ' }, { c: ' ' }], []];

describe('handleStateUpdate - content preservation', () => {
  test('full update with empty content preserves existing non-empty content', () => {
    const existing = makeState({
      panes: [makePane({ content: nonEmptyContent })],
    });
    const update: StateUpdate = {
      type: 'full',
      state: makeState({ panes: [makePane({ content: emptyContent })] }),
    };

    const result = handleStateUpdate(update, existing);
    expect(result).not.toBeNull();
    expect(result!.panes[0].content).toEqual(nonEmptyContent);
  });

  test('full update with non-empty content replaces existing content', () => {
    const existing = makeState({
      panes: [makePane({ content: nonEmptyContent })],
    });
    const newContent = [[{ c: 'w' }, { c: 'o' }, { c: 'r' }, { c: 'l' }, { c: 'd' }]];
    const update: StateUpdate = {
      type: 'full',
      state: makeState({ panes: [makePane({ content: newContent })] }),
    };

    const result = handleStateUpdate(update, existing);
    expect(result).not.toBeNull();
    expect(result!.panes[0].content).toEqual(newContent);
  });

  test('full update without existing state uses new state as-is', () => {
    const update: StateUpdate = {
      type: 'full',
      state: makeState({ panes: [makePane({ content: emptyContent })] }),
    };

    const result = handleStateUpdate(update, null);
    expect(result).not.toBeNull();
    expect(result!.panes[0].content).toEqual(emptyContent);
  });
});

describe('applyDelta - content preservation', () => {
  test('a delta that empties every row clears the pane (what `clear` sends)', () => {
    // The erase arrives as its own %output before the prompt is redrawn, so
    // the delta legitimately blanks the whole pane; holding on to the old rows
    // here left them under the new prompt.
    const state = makeState({
      panes: [makePane({ content: nonEmptyContent })],
    });
    const blanked = Object.fromEntries(nonEmptyContent.map((_, i) => [i, [{ c: ' ' }]]));
    const result = applyDelta(state, {
      seq: 1,
      panes: {
        '%0': { content: blanked },
      },
    });

    expect(result.panes[0].content).toEqual(nonEmptyContent.map(() => [{ c: ' ' }]));
  });

  test('delta with non-empty content updates normally', () => {
    const state = makeState({
      panes: [makePane({ content: nonEmptyContent })],
    });
    const newLine = [{ c: 'n' }, { c: 'e' }, { c: 'w' }];
    const result = applyDelta(state, {
      seq: 1,
      panes: {
        '%0': { content: { 0: newLine } },
      },
    });

    expect(result.panes[0].content[0]).toEqual(newLine);
  });
});

describe('handleStateUpdate — malformed updates', () => {
  // A state update the client cannot digest must never throw out of the state
  // pipeline: that exception used to unmount the whole app and leave a blank
  // page (seen after a float window appeared and vanished within one poll).
  test('keeps the current state when a full update carries no state', () => {
    const current = makeState();
    const update = { type: 'full' } as unknown as StateUpdate;
    expect(handleStateUpdate(update, current)).toBe(current);
  });

  test('keeps the current state when a delta update carries no delta', () => {
    const current = makeState();
    const update = { type: 'delta' } as unknown as StateUpdate;
    expect(handleStateUpdate(update, current)).toBe(current);
  });

  test('keeps the current state when a full update has no pane or window arrays', () => {
    const current = makeState();
    const update = {
      type: 'full',
      state: { session_name: 'test' },
    } as unknown as StateUpdate;
    expect(handleStateUpdate(update, current)).toBe(current);
  });
});
