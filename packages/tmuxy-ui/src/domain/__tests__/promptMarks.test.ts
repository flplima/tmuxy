import { describe, it, expect } from 'vitest';
import { jumpToPrompt, lastOutputNotice, promptFrom, shiftPromptRows } from '../promptMarks';
import { handleCopyModeKey } from '../copyModeKeys';
import type { CopyModeState } from '../copyMode';

/** A 10-row view over 100 rows of history, prompts on rows 20, 60, 95 and 105. */
function view(extra: Partial<CopyModeState> = {}): CopyModeState {
  return {
    mode: 'scroll',
    lines: new Map(),
    totalLines: 110,
    historySize: 100,
    loadedRanges: [],
    loading: false,
    width: 80,
    height: 10,
    cursorRow: 109,
    cursorCol: 4,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 100,
    promptRows: [20, 60, 95, 105],
    ...extra,
  };
}

describe('promptFrom', () => {
  it('finds the nearest prompt above or below, never the row itself', () => {
    const rows = [20, 60, 95];
    expect(promptFrom(rows, 60, 'previous')).toBe(20);
    expect(promptFrom(rows, 60, 'next')).toBe(95);
    expect(promptFrom(rows, 61, 'previous')).toBe(60);
    expect(promptFrom(rows, 20, 'previous')).toBeNull();
    expect(promptFrom(rows, 95, 'next')).toBeNull();
    expect(promptFrom([], 5, 'next')).toBeNull();
  });
});

describe('shiftPromptRows', () => {
  it('moves the rows with the history, and drops what moved off the top', () => {
    expect(shiftPromptRows([20, 60], 5)).toEqual([25, 65]);
    expect(shiftPromptRows([20, 60], -30)).toEqual([30]);
    expect(shiftPromptRows([20, 60], 0)).toEqual([20, 60]);
  });
});

describe('jumpToPrompt in the scroll view', () => {
  it('puts the previous prompt on the top row, from the top row', () => {
    expect(jumpToPrompt(view(), 'previous')).toEqual({ kind: 'move', state: { scrollTop: 95 } });
    expect(jumpToPrompt(view({ scrollTop: 95 }), 'previous')).toEqual({
      kind: 'move',
      state: { scrollTop: 60 },
    });
  });

  it('goes nowhere above the first prompt', () => {
    expect(jumpToPrompt(view({ scrollTop: 20 }), 'previous')).toBeNull();
    expect(jumpToPrompt(view({ promptRows: [] }), 'previous')).toBeNull();
  });

  it('goes down to the next prompt, and to the live screen when that is where it is', () => {
    expect(jumpToPrompt(view({ scrollTop: 20 }), 'next')).toEqual({
      kind: 'move',
      state: { scrollTop: 60 },
    });
    // Row 105 is on the live screen (rows 100 to 109).
    expect(jumpToPrompt(view({ scrollTop: 95 }), 'next')).toEqual({ kind: 'leave' });
    expect(jumpToPrompt(view({ scrollTop: 95, promptRows: [20, 95] }), 'next')).toEqual({
      kind: 'leave',
    });
  });
});

describe('jumpToPrompt in copy mode', () => {
  const copy = (extra: Partial<CopyModeState> = {}) => view({ mode: 'copy', ...extra });

  it('moves the cursor to the prompt, at the start of its row', () => {
    expect(jumpToPrompt(copy(), 'previous')).toEqual({
      kind: 'move',
      state: { cursorRow: 105, cursorCol: 0, scrollTop: 100 },
    });
    expect(jumpToPrompt(copy({ cursorRow: 95 }), 'previous')).toEqual({
      kind: 'move',
      state: { cursorRow: 60, cursorCol: 0, scrollTop: 60 },
    });
    expect(jumpToPrompt(copy({ cursorRow: 60 }), 'next')).toEqual({
      kind: 'move',
      state: { cursorRow: 95, cursorCol: 0, scrollTop: 95 },
    });
  });

  it('stays in the mode when there is no prompt that way', () => {
    expect(jumpToPrompt(copy({ cursorRow: 105 }), 'next')).toBeNull();
    expect(jumpToPrompt(copy({ cursorRow: 20 }), 'previous')).toBeNull();
  });

  it('[ and ] are the keys, and a selection follows the cursor', () => {
    const selecting = copy({
      cursorRow: 95,
      selectionMode: 'char',
      selectionAnchor: { row: 95, col: 2 },
    });
    const up = handleCopyModeKey('[', false, false, selecting);
    expect(up).toEqual({
      state: { cursorRow: 60, cursorCol: 0, scrollTop: 60 },
      action: null,
    });
    const down = handleCopyModeKey(']', false, false, selecting);
    expect(down.state).toEqual({ cursorRow: 105, cursorCol: 0, scrollTop: 100 });
    expect(handleCopyModeKey('[', false, false, copy({ promptRows: undefined }))).toEqual({
      state: {},
      action: null,
    });
  });
});

describe('lastOutputNotice', () => {
  it('says what was copied, or why nothing was', () => {
    expect(lastOutputNotice('ok\nfine')).toBe('Copied the last output: 7 characters');
    expect(lastOutputNotice('x')).toBe('Copied the last output: 1 character');
    expect(lastOutputNotice('')).toBe('The last command printed nothing');
    expect(lastOutputNotice(null)).toBe('No command output to copy: this shell marks none');
  });
});
