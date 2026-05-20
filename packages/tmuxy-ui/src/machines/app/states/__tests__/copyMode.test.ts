import { describe, it, expect } from 'vitest';
import { copyModeState } from '../copyMode';
import { copyModeActions, copyModeExitTimes } from '../../actions/copyMode';
import { copyModeGuards } from '../../guards/copyMode';
import { mountState, sendAndGetContext } from './testHarness';
import type { CopyModeState, CellLine, TmuxPane } from '../../../../tmux/types';

function makeCell(c: string): { c: string } {
  return { c };
}

function makeLine(text: string): CellLine {
  return text.split('').map(makeCell);
}

function makePane(tmuxId: string, content: CellLine[]): TmuxPane {
  return {
    id: 0,
    tmuxId,
    windowId: '@0',
    content,
    cursorX: 0,
    cursorY: 0,
    width: 80,
    height: content.length,
    x: 0,
    y: 0,
    active: true,
    command: 'bash',
    title: '',
    borderTitle: '',
    inMode: false,
    copyCursorX: 0,
    copyCursorY: 0,
    alternateOn: false,
    mouseAnyFlag: false,
    paused: false,
    historySize: 10,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
    cursorShape: 0,
    cursorHidden: false,
  };
}

function makeCopyState(extra: Partial<CopyModeState> = {}): CopyModeState {
  const lines = new Map<number, CellLine>();
  lines.set(10, makeLine('hello world'));
  lines.set(11, makeLine('second line'));
  return {
    lines,
    totalLines: 12,
    historySize: 10,
    loadedRanges: [[10, 11]],
    loading: false,
    width: 80,
    height: 2,
    cursorRow: 10,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 10,
    ...extra,
  };
}

describe('copyMode state', () => {
  it('ENTER_COPY_MODE initializes copyModeStates for the pane', () => {
    const pane = makePane('%1', [makeLine('line a'), makeLine('line b')]);
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      panes: [pane],
    });
    const ctx = sendAndGetContext(actor, { type: 'ENTER_COPY_MODE', paneId: '%1' });
    expect(ctx.copyModeStates['%1']).toBeDefined();
    expect(ctx.copyModeStates['%1'].historySize).toBe(10);
    expect(ctx.copyModeStates['%1'].lines.size).toBeGreaterThan(0);
  });

  it('EXIT_COPY_MODE removes the pane from copyModeStates and stamps exit time', () => {
    const before = Date.now();
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: { '%1': makeCopyState() },
    });
    const ctx = sendAndGetContext(actor, { type: 'EXIT_COPY_MODE', paneId: '%1' });
    expect(ctx.copyModeStates['%1']).toBeUndefined();
    const exitTime = copyModeExitTimes.get('%1');
    expect(exitTime).toBeGreaterThanOrEqual(before);
  });

  it('COPY_MODE_SELECTION_CLEAR clears selection but keeps cursor', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: {
        '%1': makeCopyState({
          selectionMode: 'char',
          selectionAnchor: { row: 10, col: 0 },
          cursorRow: 10,
          cursorCol: 5,
        }),
      },
    });
    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_SELECTION_CLEAR', paneId: '%1' });
    expect(ctx.copyModeStates['%1'].selectionMode).toBeNull();
    expect(ctx.copyModeStates['%1'].selectionAnchor).toBeNull();
    expect(ctx.copyModeStates['%1'].cursorRow).toBe(10);
    expect(ctx.copyModeStates['%1'].cursorCol).toBe(5);
  });

  it('COPY_MODE_WORD_SELECT expands selection to word boundaries', () => {
    // line at row 10: "hello world" — selecting col 1 should expand to "hello"
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: { '%1': makeCopyState() },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_WORD_SELECT',
      paneId: '%1',
      row: 10,
      col: 1,
      broad: false,
    });
    const updated = ctx.copyModeStates['%1'];
    expect(updated.selectionMode).toBe('char');
    expect(updated.selectionAnchor?.col).toBe(0); // start of "hello"
    expect(updated.cursorCol).toBe(4); // end of "hello"
  });

  it('COPY_MODE_LINE_SELECT selects entire line', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: { '%1': makeCopyState() },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_LINE_SELECT',
      paneId: '%1',
      row: 10,
    });
    const updated = ctx.copyModeStates['%1'];
    expect(updated.selectionMode).toBe('line');
    expect(updated.selectionAnchor?.col).toBe(0);
    expect(updated.cursorCol).toBe(updated.width - 1);
  });

  it('COPY_MODE_CURSOR_MOVE clamps within total lines', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: { '%1': makeCopyState({ totalLines: 12 }) },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_CURSOR_MOVE',
      paneId: '%1',
      row: 9999,
      col: 0,
      relative: false,
    });
    expect(ctx.copyModeStates['%1'].cursorRow).toBe(11); // totalLines - 1
  });

  it('COPY_MODE_SELECTION_START with totalLines=0 stores pendingSelection', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: {
        '%1': makeCopyState({ totalLines: 0, lines: new Map() }),
      },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_SELECTION_START',
      paneId: '%1',
      mode: 'char',
      row: 0,
      col: 3,
    });
    expect(ctx.copyModeStates['%1'].pendingSelection).toEqual({
      mode: 'char',
      row: 0,
      col: 3,
    });
  });

  it('events targeting unknown pane are no-ops', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: {},
    });
    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_SELECTION_CLEAR', paneId: '%99' });
    expect(ctx.copyModeStates).toEqual({});
  });
});
