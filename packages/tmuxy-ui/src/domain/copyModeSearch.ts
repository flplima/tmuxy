import {
  firstUnloadedGap,
  type CopyModeState,
  type CopySearch,
  type SearchDir,
  type SearchMatch,
  type SearchQuery,
} from './copyMode';
import type { CellLine } from './wireCells';

export const NOT_FOUND_MS = 2000;

/** Smart case, as vim and tmux do it: a capital in the query makes it exact. */
function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

interface RowText {
  text: string;
  /** For each UTF-16 offset of `text`, the cell it came from. */
  cellAt: number[];
}

function rowText(line: CellLine, fold: boolean): RowText {
  let text = '';
  const cellAt: number[] = [];
  line.forEach((cell, i) => {
    const part = fold ? cell.c.toLowerCase() : cell.c;
    for (let k = 0; k < part.length; k++) cellAt.push(i);
    text += part;
  });
  return { text, cellAt };
}

/** Every match on one row, left to right. */
function matchesInRow(row: number, line: CellLine | undefined, query: string): SearchMatch[] {
  if (!line || query === '') return [];
  const fold = !isCaseSensitive(query);
  const { text, cellAt } = rowText(line, fold);
  const needle = fold ? query.toLowerCase() : query;
  const found: SearchMatch[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const col = cellAt[at];
    let last = cellAt[at + needle.length - 1];
    // A wide character's second cell holds no text of its own; it is part of the match.
    while (line[last + 1] !== undefined && line[last + 1].c === '') last++;
    found.push({ row, col, len: last - col + 1 });
  }
  return found;
}

/** The matches of `query` on rows `first..last`, for painting the ones in view. */
export function matchesInRows(
  state: Pick<CopyModeState, 'lines' | 'totalLines'>,
  query: string,
  first: number,
  last: number,
): SearchMatch[] {
  const found: SearchMatch[] = [];
  const end = Math.min(last, state.totalLines - 1);
  for (let row = Math.max(0, first); row <= end; row++) {
    found.push(...matchesInRow(row, state.lines.get(row), query));
  }
  return found;
}

/**
 * The next match from the cursor in `dir`, wrapping at the ends of history; the
 * match under the cursor counts last, once the search has gone all the way
 * round. Needs every row loaded.
 */
export function findMatch(state: CopyModeState, { dir, query }: SearchQuery): SearchMatch | null {
  const { cursorRow, cursorCol, totalLines } = state;
  if (query === '' || totalLines <= 0) return null;
  const step = dir === 'down' ? 1 : -1;
  for (let i = 0; i <= totalLines; i++) {
    const row = (((cursorRow + step * i) % totalLines) + totalLines) % totalLines;
    let hits = matchesInRow(row, state.lines.get(row), query);
    if (i === 0)
      hits = hits.filter((m) => (dir === 'down' ? m.col > cursorCol : m.col < cursorCol));
    else if (i === totalLines) {
      hits = hits.filter((m) => (dir === 'down' ? m.col <= cursorCol : m.col >= cursorCol));
    }
    if (hits.length > 0) return dir === 'down' ? hits[0] : hits[hits.length - 1];
  }
  return null;
}

/** Runs a search over fully loaded rows (`last` is the caller's to set): moves the cursor to the match, or says nothing matched. */
export function runSearch(state: CopyModeState, q: SearchQuery): CopyModeState {
  const match = findMatch(state, q);
  const search: CopySearch = { ...state.search, pending: undefined };
  if (!match) return { ...state, search: { ...search, notFound: true } };
  const { height, totalLines } = state;
  const inView = match.row >= state.scrollTop && match.row < state.scrollTop + height;
  const centred = Math.max(0, Math.min(totalLines - height, match.row - Math.floor(height / 2)));
  return {
    ...state,
    cursorRow: match.row,
    cursorCol: match.col,
    scrollTop: inView ? state.scrollTop : centred,
    search: { ...search, match, notFound: false },
  };
}

/**
 * Starts a search. A history with rows still unloaded cannot be searched
 * whole, so the search waits (`pending`) and returns the gap to fetch first.
 */
export function beginSearch(
  state: CopyModeState,
  q: SearchQuery,
): { state: CopyModeState; gap: [number, number] | null } {
  const gap = firstUnloadedGap(state.loadedRanges, state.totalLines);
  if (!gap) return { state: runSearch(state, q), gap: null };
  const search: CopySearch = { ...state.search, pending: q, notFound: false };
  return { state: { ...state, search, loading: true }, gap };
}

export interface SearchKeyResult {
  search: CopySearch;
  run?: SearchQuery;
}

const opposite = (dir: SearchDir): SearchDir => (dir === 'down' ? 'up' : 'down');

function promptKey(key: string, ctrlKey: boolean, search: CopySearch): SearchKeyResult {
  const prompt = search.prompt as SearchQuery;
  const cleared: CopySearch = { ...search, notFound: false };
  const edit = (query: string): SearchKeyResult => ({
    search: { ...cleared, prompt: { ...prompt, query } },
  });
  if (key === 'Escape') return { search: { ...cleared, prompt: undefined } };
  if (key === 'Enter') {
    const q = prompt.query === '' && search.last ? { ...search.last, dir: prompt.dir } : prompt;
    if (q.query === '') return { search: { ...cleared, prompt: undefined } };
    return { search: { ...cleared, prompt: undefined, last: q }, run: q };
  }
  if (key === 'Backspace') {
    return prompt.query === ''
      ? { search: { ...cleared, prompt: undefined } }
      : edit([...prompt.query].slice(0, -1).join(''));
  }
  if (ctrlKey) return key === 'u' ? edit('') : { search };
  return [...key].length === 1 ? edit(prompt.query + key) : { search };
}

/**
 * The search keys of copy mode's vi table: `/` and `?` open the prompt, `n`
 * and `N` repeat the last search. While the prompt is open every key is its
 * own. Null for a key that is not the search's.
 */
export function handleSearchKey(
  key: string,
  ctrlKey: boolean,
  state: CopyModeState,
): SearchKeyResult | null {
  const search = state.search ?? {};
  if (search.prompt) return promptKey(key, ctrlKey, search);
  if (ctrlKey) return null;
  const cleared: CopySearch = { ...search, notFound: false };
  if (key === '/' || key === '?') {
    const dir = key === '/' ? 'down' : 'up';
    return { search: { ...cleared, prompt: { dir, query: '' } } };
  }
  if ((key === 'n' || key === 'N') && search.last) {
    const dir = key === 'n' ? search.last.dir : opposite(search.last.dir);
    return { search: cleared, run: { ...search.last, dir } };
  }
  return key === 'n' || key === 'N' ? { search: cleared } : null;
}
