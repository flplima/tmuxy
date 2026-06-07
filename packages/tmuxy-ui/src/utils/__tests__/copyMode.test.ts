import { describe, it, expect } from 'vitest';
import { extractSelectedText, isWrappedRow } from '../copyMode';
import type { CopyModeState, CellLine } from '../../tmux/types';

function makeLine(text: string): CellLine {
  return text.split('').map((c) => ({ c }));
}

const WIDTH = 10;

function makeState(
  rows: Record<number, string>,
  extra: Partial<CopyModeState> = {},
): CopyModeState {
  const lines = new Map<number, CellLine>();
  for (const [row, text] of Object.entries(rows)) {
    lines.set(Number(row), makeLine(text));
  }
  return {
    lines,
    totalLines: Object.keys(rows).length,
    historySize: 0,
    loadedRanges: [],
    loading: false,
    width: WIDTH,
    height: Object.keys(rows).length,
    cursorRow: 0,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 0,
    ...extra,
  };
}

describe('isWrappedRow', () => {
  it('is true when the row fills the full width', () => {
    expect(isWrappedRow(makeLine('0123456789'), WIDTH)).toBe(true);
  });

  it('is false when the row is shorter than the width', () => {
    expect(isWrappedRow(makeLine('abc'), WIDTH)).toBe(false);
  });

  it('is false for an unloaded (undefined) row', () => {
    expect(isWrappedRow(undefined, WIDTH)).toBe(false);
  });
});

describe('extractSelectedText', () => {
  it('returns empty string when there is no selection', () => {
    expect(extractSelectedText(makeState({ 0: 'hello' }))).toBe('');
  });

  it('joins a wrapped logical line into one line (line mode)', () => {
    // "0123456789abc" wrapped at width 10 across rows 0 and 1
    const state = makeState(
      { 0: '0123456789', 1: 'abc' },
      {
        selectionMode: 'line',
        selectionAnchor: { row: 0, col: 0 },
        cursorRow: 1,
        cursorCol: WIDTH - 1,
      },
    );
    expect(extractSelectedText(state)).toBe('0123456789abc');
  });

  it('keeps a newline between separate (non-wrapped) logical lines', () => {
    const state = makeState(
      { 0: 'hello', 1: 'world' },
      {
        selectionMode: 'line',
        selectionAnchor: { row: 0, col: 0 },
        cursorRow: 1,
        cursorCol: WIDTH - 1,
      },
    );
    expect(extractSelectedText(state)).toBe('hello\nworld');
  });

  it('joins across a wrap boundary in char mode', () => {
    const state = makeState(
      { 0: '0123456789', 1: 'abc' },
      {
        selectionMode: 'char',
        selectionAnchor: { row: 0, col: 2 },
        cursorRow: 1,
        cursorCol: 1,
      },
    );
    expect(extractSelectedText(state)).toBe('23456789ab');
  });

  it('mixes wrapped joins and hard line breaks in one selection', () => {
    // rows 0+1 are one wrapped logical line; row 2 is a separate line
    const state = makeState(
      { 0: '0123456789', 1: 'tail', 2: 'next' },
      {
        selectionMode: 'line',
        selectionAnchor: { row: 0, col: 0 },
        cursorRow: 2,
        cursorCol: WIDTH - 1,
      },
    );
    expect(extractSelectedText(state)).toBe('0123456789tail\nnext');
  });
});
