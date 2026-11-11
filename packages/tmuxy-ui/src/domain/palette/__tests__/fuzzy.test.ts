import { describe, it, expect } from 'vitest';
import { fuzzyMatch, rank } from '../fuzzy';

const labels = (query: string, items: string[]) =>
  rank(
    items.map((label) => ({ label })),
    query,
  ).map((r) => r.item.label);

describe('fuzzyMatch', () => {
  it('finds the letters in order, wherever they are, ignoring case', () => {
    expect(fuzzyMatch('spb', 'Split Pane Below')?.positions).toEqual([0, 1, 11]);
    expect(fuzzyMatch('pb', 'Split Pane Below')?.positions).toEqual([6, 11]);
    expect(fuzzyMatch('SPLIT', 'split pane')?.positions).toEqual([0, 1, 2, 3, 4]);
  });

  it('refuses text that lacks a letter or has them out of order', () => {
    expect(fuzzyMatch('xyz', 'Split Pane Below')).toBeNull();
    expect(fuzzyMatch('ts', 'Split')).toBeNull();
    expect(fuzzyMatch('longer than it', 'short')).toBeNull();
  });

  it('matches everything with an empty needle', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('prefers letters that run together to ones scattered about', () => {
    const together = fuzzyMatch('tab', 'New Tab')!;
    const scattered = fuzzyMatch('tab', 'Toggle a Border')!;
    expect(together.score).toBeGreaterThan(scattered.score);
    expect(together.positions).toEqual([4, 5, 6]);
  });

  it('prefers the start of a word to its middle', () => {
    expect(fuzzyMatch('p', 'Paste')!.score).toBeGreaterThan(fuzzyMatch('p', 'Swap')!.score);
    expect(fuzzyMatch('nt', 'New Tab')!.score).toBeGreaterThan(fuzzyMatch('nt', 'Next')!.score);
  });

  it('marks the word starts it scored, not the first letters it met', () => {
    // The `s` of "Session", not the one in "Pass".
    expect(fuzzyMatch('ks', 'Kill Pass Session')?.positions).toEqual([0, 10]);
  });
});

describe('rank', () => {
  const MENU = [
    'Swap with Previous',
    'Split Pane Below',
    'Split Pane Right',
    'Paste',
    'Show All Tabs',
    'Stacked Panes',
  ];

  it('keeps everything in order for an empty query', () => {
    expect(labels('  ', MENU)).toEqual(MENU);
  });

  it('puts both splits first for "split"', () => {
    expect(labels('split', MENU).slice(0, 2)).toEqual(['Split Pane Below', 'Split Pane Right']);
  });

  it('takes every word of the query, in any order', () => {
    expect(labels('right split', MENU)).toEqual(['Split Pane Right']);
    expect(labels('split zzz', MENU)).toEqual([]);
  });

  it('keeps the incoming order between equal matches', () => {
    expect(labels('a', ['alpha', 'alpha'])).toEqual(['alpha', 'alpha']);
    expect(labels('split pane', MENU).slice(0, 2)).toEqual([
      'Split Pane Below',
      'Split Pane Right',
    ]);
  });

  // "close" fits Close Pane, Close Tab and Close Window alike, and "re"
  // fits Reload Config, Rename Session and Restart App: a row that ends
  // something never leads on a tie, and among such rows the shortest label
  // has no claim either.
  it('never puts a row marked last ahead of an equal match that is not', () => {
    const items = [
      { label: 'Restart App', last: true },
      { label: 'Reload Config' },
      { label: 'Rename Session' },
    ];
    expect(rank(items, 're').map((r) => r.item.label)).toEqual([
      'Reload Config',
      'Rename Session',
      'Restart App',
    ]);
    const closes = [
      { label: 'Close Pane', last: true },
      { label: 'Close Tab', last: true },
      { label: 'Close Window', last: true },
    ];
    expect(rank(closes, 'close').map((r) => r.item.label)).toEqual([
      'Close Pane',
      'Close Tab',
      'Close Window',
    ]);
    // A better match still leads, marked or not.
    expect(rank(items, 'restart')[0].item.label).toBe('Restart App');
  });

  it('prefers the shorter label between equal matches that are not marked', () => {
    expect(labels('pa', ['Paste Buffer Here', 'Paste'])).toEqual(['Paste', 'Paste Buffer Here']);
  });

  it('finds an item by what is beside its label, below one found by the label', () => {
    const items = [
      { label: 'Dark Mode', extra: 'View › Theme' },
      { label: 'Theme Park', extra: '' },
    ];
    const found = rank(items, 'theme');
    expect(found.map((r) => r.item.label)).toEqual(['Theme Park', 'Dark Mode']);
    // Nothing of "Dark Mode" itself matched, so nothing in it is marked.
    expect(found[1].positions).toEqual([]);
    expect(found[0].positions).toEqual([0, 1, 2, 3, 4]);
  });
});
