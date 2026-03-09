import { describe, test, expect } from 'vitest';
import { handleStateUpdate, applyDelta } from '../deltaProtocol';
import type { ServerState, ServerPane, StateUpdate } from '../types';

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
    windows: [{ id: '@0', index: 1, name: 'test', active: true, is_pane_group_window: false }],
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
  test('delta with all-empty content preserves existing non-empty content', () => {
    const state = makeState({
      panes: [makePane({ content: nonEmptyContent })],
    });
    const result = applyDelta(state, {
      seq: 1,
      panes: {
        '%0': { content: { 0: [{ c: ' ' }] } },
      },
    });

    // The merged content would be all-empty (single space), but existing was non-empty
    // so existing content is preserved
    expect(result.panes[0].content).toEqual(nonEmptyContent);
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
