import { describe, it, expect } from 'vitest';
import { extractSelectedText, firstUnloadedGap, isWrappedRow } from '../copyMode';
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
    mode: 'copy',
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

describe('firstUnloadedGap', () => {
  it('finds the hole lazy loading leaves in the middle', () => {
    // The shape a select-all hits: the tail loaded on entry, the top filled
    // after the real history size arrived, and nothing in between — which is
    // the middle of the copied text going missing.
    expect(
      firstUnloadedGap(
        [
          [0, 29],
          [196, 309],
        ],
        310,
      ),
    ).toEqual([30, 195]);
  });

  it('reports the rows above and below what is loaded', () => {
    expect(firstUnloadedGap([[100, 200]], 310)).toEqual([0, 99]);
    expect(firstUnloadedGap([[0, 200]], 310)).toEqual([201, 309]);
  });

  it('is null once every row is covered', () => {
    expect(firstUnloadedGap([[0, 309]], 310)).toBeNull();
    expect(
      firstUnloadedGap(
        [
          [0, 100],
          [101, 309],
        ],
        310,
      ),
    ).toBeNull();
    // Overlapping and out-of-order ranges still count as covered.
    expect(
      firstUnloadedGap(
        [
          [50, 309],
          [0, 80],
        ],
        310,
      ),
    ).toBeNull();
  });

  it('has nothing to fill in an empty scrollback', () => {
    expect(firstUnloadedGap([], 0)).toBeNull();
    expect(firstUnloadedGap([], 5)).toEqual([0, 4]);
  });
});
