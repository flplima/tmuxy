import { describe, it, expect } from 'vitest';
import {
  sliceCopyModeStates,
  sliceStatusLine,
  sliceActivationOrder,
  sliceLastActivePaneByWindow,
  detectRemovedPanes,
  type TransformedState,
} from '../tmuxStateSlices';
import type { CopyModeState, CellLine } from '../../../tmux/types';
import type { TmuxPane, TmuxWindow } from '../../types';

function emptyCopyState(): CopyModeState {
  return {
    lines: new Map<number, CellLine>(),
    totalLines: 0,
    historySize: 0,
    loadedRanges: [],
    loading: false,
    width: 80,
    height: 24,
    cursorRow: 0,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 0,
  };
}

function pane(tmuxId: string, opts: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: 0,
    tmuxId,
    windowId: opts.windowId ?? '@0',
    content: [],
    cursorX: 0,
    cursorY: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 0,
    active: opts.active ?? false,
    command: 'bash',
    title: '',
    borderTitle: '',
    inMode: opts.inMode ?? false,
    copyCursorX: 0,
    copyCursorY: 0,
    alternateOn: false,
    mouseAnyFlag: false,
    paused: false,
    historySize: 0,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
    cursorShape: 0,
    cursorHidden: false,
    ...opts,
  };
}

function window_(id: string, opts: Partial<TmuxWindow> = {}): TmuxWindow {
  return {
    id,
    index: 0,
    name: 'w',
    active: false,
    isPaneGroupWindow: false,
    paneGroupPaneIds: null,
    isFloatWindow: false,
    floatPaneId: null,
    ...opts,
  };
}

function tx(overrides: Partial<TransformedState> = {}): TransformedState {
  return {
    panes: [],
    windows: [],
    activeWindowId: null,
    activePaneId: null,
    ...overrides,
  };
}

describe('sliceCopyModeStates', () => {
  it('drops entries for panes that no longer exist', () => {
    const current = { '%1': emptyCopyState(), '%2': emptyCopyState() };
    const next = tx({ panes: [pane('%1', { inMode: true })] });
    const result = sliceCopyModeStates(current, next);
    expect(Object.keys(result)).toEqual(['%1']);
  });

  it('drops entries for panes that exited copy mode server-side', () => {
    const current = { '%1': emptyCopyState() };
    const next = tx({ panes: [pane('%1', { inMode: false })] });
    const result = sliceCopyModeStates(current, next);
    expect(result['%1']).toBeUndefined();
  });

  it('returns the input by reference when nothing changes', () => {
    const current = { '%1': emptyCopyState() };
    const next = tx({ panes: [pane('%1', { inMode: true })] });
    const result = sliceCopyModeStates(current, next);
    expect(result).toBe(current);
  });
});

describe('sliceStatusLine', () => {
  it('returns the new line when it changed', () => {
    expect(sliceStatusLine('a', tx({ statusLine: 'b' }))).toBe('b');
  });
  it('returns undefined when unchanged', () => {
    expect(sliceStatusLine('a', tx({ statusLine: 'a' }))).toBeUndefined();
  });
  it('returns undefined when next has no statusLine', () => {
    expect(sliceStatusLine('a', tx({}))).toBeUndefined();
  });
});

describe('sliceActivationOrder', () => {
  it('promotes the new active pane to the front', () => {
    const result = sliceActivationOrder(['%1', '%2'], '%2', [pane('%1'), pane('%2')]);
    expect(result).toEqual(['%2', '%1']);
  });

  it('returns undefined when active pane is already at the front and no panes died', () => {
    const result = sliceActivationOrder(['%1'], '%1', [pane('%1')]);
    expect(result).toBeUndefined();
  });

  it('prunes dead panes even without a new active', () => {
    const result = sliceActivationOrder(['%1', '%2'], null, [pane('%1')]);
    expect(result).toEqual(['%1']);
  });

  it('returns undefined when no changes and no new active', () => {
    const result = sliceActivationOrder(['%1'], null, [pane('%1')]);
    expect(result).toBeUndefined();
  });
});

describe('sliceLastActivePaneByWindow', () => {
  it('records the active pane per window', () => {
    const next = tx({
      panes: [pane('%1', { windowId: '@0', active: true })],
      windows: [window_('@0')],
    });
    const result = sliceLastActivePaneByWindow({}, next);
    expect(result).toEqual({ '@0': '%1' });
  });

  it('prunes entries for windows that no longer exist', () => {
    const next = tx({
      panes: [pane('%1', { windowId: '@1', active: true })],
      windows: [window_('@1')],
    });
    const result = sliceLastActivePaneByWindow({ '@0': '%99' }, next);
    expect(result).toEqual({ '@1': '%1' });
  });

  it('returns undefined when nothing changes', () => {
    const next = tx({
      panes: [pane('%1', { windowId: '@0', active: true })],
      windows: [window_('@0')],
    });
    const result = sliceLastActivePaneByWindow({ '@0': '%1' }, next);
    expect(result).toBeUndefined();
  });
});

describe('detectRemovedPanes', () => {
  it('reports panes that vanished', () => {
    expect(detectRemovedPanes([pane('%1'), pane('%2')], [pane('%1')])).toEqual(['%2']);
  });
  it('excludes optimistic placeholders from the result', () => {
    expect(detectRemovedPanes([pane('%1'), pane('__placeholder_split_42')], [pane('%1')])).toEqual(
      [],
    );
  });
  it('returns empty when no panes were removed', () => {
    expect(detectRemovedPanes([pane('%1')], [pane('%1'), pane('%2')])).toEqual([]);
  });
});
