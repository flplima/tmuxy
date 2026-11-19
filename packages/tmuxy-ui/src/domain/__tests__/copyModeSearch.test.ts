import { describe, it, expect } from 'vitest';
import type { CopyModeState } from '../copyMode';
import {
  beginSearch,
  findMatch,
  handleSearchKey,
  matchesInRows,
  runSearch,
  type SearchKeyResult,
} from '../copyModeSearch';
import type { CellLine } from '../wireCells';
import { cellLine } from '../../test/model';

function makeState(rows: string[], extra: Partial<CopyModeState> = {}): CopyModeState {
  const lines = new Map<number, CellLine>();
  rows.forEach((text, row) => lines.set(row, cellLine(text)));
  return {
    mode: 'copy',
    lines,
    totalLines: rows.length,
    historySize: 0,
    loadedRanges: [[0, rows.length - 1]],
    loading: false,
    width: 40,
    height: 3,
    cursorRow: 0,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 0,
    ...extra,
  };
}

const HISTORY = ['alpha', 'beta needle', 'gamma', 'needle again', 'delta', 'epsilon', 'zeta'];
const down = (query: string) => ({ dir: 'down' as const, query });
const up = (query: string) => ({ dir: 'up' as const, query });

describe('findMatch', () => {
  it('searches down from the cursor, to the first cell of the match', () => {
    expect(findMatch(makeState(HISTORY), down('needle'))).toEqual({ row: 1, col: 5, len: 6 });
  });

  it('skips the match under the cursor and goes on to the next', () => {
    const state = makeState(HISTORY, { cursorRow: 1, cursorCol: 5 });
    expect(findMatch(state, down('needle'))?.row).toBe(3);
  });

  it('finds a second match on the same row, to the right of the cursor', () => {
    const state = makeState(['ab ab ab'], { cursorCol: 0 });
    expect(findMatch(state, down('ab'))?.col).toBe(3);
  });

  it('searches up, towards older rows', () => {
    const state = makeState(HISTORY, { cursorRow: 6 });
    expect(findMatch(state, up('needle'))?.row).toBe(3);
  });

  it('wraps past the end going down and past the start going up', () => {
    expect(findMatch(makeState(HISTORY, { cursorRow: 5 }), down('needle'))?.row).toBe(1);
    expect(findMatch(makeState(HISTORY, { cursorRow: 0 }), up('needle'))?.row).toBe(3);
  });

  it('lands back on the only match once it has gone all the way round', () => {
    const state = makeState(HISTORY, { cursorRow: 2 });
    expect(findMatch(state, down('gamma'))).toEqual({ row: 2, col: 0, len: 5 });
  });

  it('is case-insensitive without a capital in the query, exact with one', () => {
    const rows = ['Foo', 'foo'];
    expect(findMatch(makeState(rows), down('foo'))?.row).toBe(1);
    expect(findMatch(makeState(rows, { cursorRow: 1 }), down('foo'))?.row).toBe(0);
    expect(findMatch(makeState(rows), down('Foo'))?.row).toBe(0);
    expect(findMatch(makeState(['foo']), down('Foo'))).toBeNull();
  });

  it('covers both cells of a wide character, and counts columns, not letters', () => {
    const wide: CellLine = [{ c: 'a' }, { c: '世' }, { c: '' }, { c: '界' }, { c: '' }, { c: 'z' }];
    const state = makeState([], { lines: new Map([[0, wide]]), totalLines: 1 });
    expect(findMatch(state, down('界z'))).toEqual({ row: 0, col: 3, len: 3 });
    expect(findMatch(state, down('世'))).toEqual({ row: 0, col: 1, len: 2 });
  });

  it('finds nothing for text that is not there, or an empty query', () => {
    expect(findMatch(makeState(HISTORY), down('absent'))).toBeNull();
    expect(findMatch(makeState(HISTORY), down(''))).toBeNull();
  });
});

describe('runSearch', () => {
  it('moves the cursor to the match and scrolls it into view', () => {
    const next = runSearch(makeState(HISTORY, { height: 2 }), down('zeta'));
    expect([next.cursorRow, next.cursorCol]).toEqual([6, 0]);
    expect(next.scrollTop).toBeGreaterThan(0);
    expect(next.scrollTop).toBeLessThanOrEqual(5);
    expect(next.search?.match).toEqual({ row: 6, col: 0, len: 4 });
  });

  it('leaves the scroll alone for a match already in view', () => {
    const next = runSearch(makeState(HISTORY, { scrollTop: 1 }), down('gamma'));
    expect(next.scrollTop).toBe(1);
  });

  it('keeps the cursor and the selection, and says so, when nothing matches', () => {
    const state = makeState(HISTORY, {
      cursorRow: 2,
      cursorCol: 1,
      selectionMode: 'char',
      selectionAnchor: { row: 0, col: 0 },
    });
    const next = runSearch(state, down('absent'));
    expect([next.cursorRow, next.cursorCol]).toEqual([2, 1]);
    expect(next.selectionAnchor).toEqual({ row: 0, col: 0 });
    expect(next.search?.notFound).toBe(true);
  });

  it('extends an active selection, whose moving end is the cursor', () => {
    const state = makeState(HISTORY, {
      selectionMode: 'char',
      selectionAnchor: { row: 0, col: 0 },
    });
    const next = runSearch(state, down('delta'));
    expect(next.selectionMode).toBe('char');
    expect(next.selectionAnchor).toEqual({ row: 0, col: 0 });
    expect(next.cursorRow).toBe(4);
  });
});

describe('beginSearch', () => {
  it('waits for the rows still unloaded, and names the first gap', () => {
    const state = makeState(HISTORY, { loadedRanges: [[4, 6]] });
    const begun = beginSearch(state, down('needle'));
    expect(begun.gap).toEqual([0, 3]);
    expect(begun.state.search?.pending).toEqual(down('needle'));
    expect(begun.state.cursorRow).toBe(0);
  });

  it('runs at once when every row is loaded', () => {
    const begun = beginSearch(makeState(HISTORY), down('needle'));
    expect(begun.gap).toBeNull();
    expect(begun.state.cursorRow).toBe(1);
  });
});

describe('handleSearchKey', () => {
  const keys = (state: CopyModeState, ...seq: string[]) =>
    seq.reduce<{ state: CopyModeState; last: SearchKeyResult | null }>(
      (acc, key) => {
        const result = handleSearchKey(key, false, acc.state);
        return result
          ? { state: { ...acc.state, search: result.search }, last: result }
          : { ...acc, last: null };
      },
      { state, last: null },
    );

  it('opens the prompt downwards on / and upwards on ?', () => {
    expect(keys(makeState(HISTORY), '/').state.search?.prompt).toEqual(down(''));
    expect(keys(makeState(HISTORY), '?').state.search?.prompt).toEqual(up(''));
  });

  it('types, deletes with Backspace and runs on Enter, remembering the query', () => {
    const typed = keys(makeState(HISTORY), '/', 'n', 'x', 'Backspace', 'e');
    expect(typed.state.search?.prompt?.query).toBe('ne');
    const entered = keys(typed.state, 'Enter');
    expect(entered.last?.run).toEqual(down('ne'));
    expect(entered.state.search?.prompt).toBeUndefined();
    expect(entered.state.search?.last).toEqual(down('ne'));
  });

  it('takes every key while the prompt is open, so n and q are text', () => {
    const typed = keys(makeState(HISTORY), '/', 'q', 'n', 'N');
    expect(typed.state.search?.prompt?.query).toBe('qnN');
  });

  it('closes the prompt on Escape without running anything', () => {
    const closed = keys(makeState(HISTORY), '/', 'a', 'Escape');
    expect(closed.state.search?.prompt).toBeUndefined();
    expect(closed.last?.run).toBeUndefined();
  });

  it('closes the prompt on Backspace in an empty query', () => {
    expect(keys(makeState(HISTORY), '/', 'Backspace').state.search?.prompt).toBeUndefined();
  });

  it('repeats with n in the same direction and N in the other', () => {
    const state = makeState(HISTORY, { search: { last: up('needle') } });
    expect(handleSearchKey('n', false, state)?.run).toEqual(up('needle'));
    expect(handleSearchKey('N', false, state)?.run).toEqual(down('needle'));
  });

  it('keeps the direction N reversed from, so n after N still follows the original', () => {
    const state = makeState(HISTORY, { search: { last: down('needle') } });
    const reversed = handleSearchKey('N', false, state);
    expect(reversed?.search.last).toEqual(down('needle'));
  });

  it('ignores n with no search to repeat, and keys that are not the search', () => {
    expect(handleSearchKey('n', false, makeState(HISTORY))?.run).toBeUndefined();
    expect(handleSearchKey('j', false, makeState(HISTORY))).toBeNull();
    expect(handleSearchKey('u', true, makeState(HISTORY))).toBeNull();
  });
});

describe('matchesInRows', () => {
  it('lists every match in the rows asked for', () => {
    const found = matchesInRows(makeState(HISTORY), 'needle', 0, 2);
    expect(found).toEqual([{ row: 1, col: 5, len: 6 }]);
  });
});
