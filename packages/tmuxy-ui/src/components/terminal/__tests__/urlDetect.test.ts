import { describe, it, expect } from 'vitest';
import { detectUrls, detectUrlsAcrossRows } from '../urlDetect';
import type { CellLine } from '../../../domain/wireCells';

/** What the detector would underline, as substrings of the input. */
const covered = (text: string) => detectUrls(text).map((u) => text.slice(u.start, u.end));

describe('detectUrls', () => {
  it('finds a plain URL and reports the range that holds it', () => {
    const text = 'see https://example.com/a for more';
    expect(detectUrls(text)).toEqual([{ start: 4, end: 25, url: 'https://example.com/a' }]);
    expect(covered(text)).toEqual(['https://example.com/a']);
  });

  it('finds several URLs on one line', () => {
    expect(covered('http://a.test/1 and https://b.test/2')).toEqual([
      'http://a.test/1',
      'https://b.test/2',
    ]);
  });

  it('keeps the query and fragment', () => {
    expect(covered('https://ex.test/p?a=1&b=2#frag')).toEqual(['https://ex.test/p?a=1&b=2#frag']);
  });

  it('drops sentence punctuation that follows the URL', () => {
    expect(covered('go to https://ex.test/a.')).toEqual(['https://ex.test/a']);
    expect(covered('(https://ex.test/a)')).toEqual(['https://ex.test/a']);
    expect(covered('https://ex.test/a, https://ex.test/b!')).toEqual([
      'https://ex.test/a',
      'https://ex.test/b',
    ]);
  });

  it('matches an internationalised address', () => {
    expect(covered('https://例え.jp/パス')).toEqual(['https://例え.jp/パス']);
  });

  // The reported bug's other half: a highlight covering a lot of wrong text.
  // A terminal UI puts its separators right up against the text, and the
  // detector used to be defined by what it excluded, so it ate all of them.
  describe('stops at characters a URL cannot contain', () => {
    it('stops at a box-drawing separator with no space around it', () => {
      expect(covered('https://gh.test/foo/bar│Files:12│Status:ok')).toEqual([
        'https://gh.test/foo/bar',
      ]);
      expect(covered('│https://ex.test/a│')).toEqual(['https://ex.test/a']);
    });

    it('stops at an arrow, an ellipsis and a pipe', () => {
      expect(covered('https://ex.test/path→next')).toEqual(['https://ex.test/path']);
      expect(covered('https://ex.test/a…and more prose')).toEqual(['https://ex.test/a']);
      expect(covered('url=https://ex.test/a&b=1|next')).toEqual(['https://ex.test/a&b=1']);
    });

    it('stops at quotes, brackets and whitespace', () => {
      expect(covered('"https://ex.test/a" <https://ex.test/b>')).toEqual([
        'https://ex.test/a',
        'https://ex.test/b',
      ]);
      expect(covered('{https://ex.test/a}')).toEqual(['https://ex.test/a']);
      expect(covered('`https://ex.test/a`')).toEqual(['https://ex.test/a']);
    });
  });

  it('finds nothing in text without a scheme', () => {
    expect(detectUrls('example.com/a and ftp://ex.test/b')).toEqual([]);
  });
});

/** Rows of a pane `width` wide, each string one row's cells. */
const rows = (...texts: string[]): CellLine[] => texts.map((t) => [...t].map((c) => ({ c })));

describe('detectUrlsAcrossRows', () => {
  const width = 10;

  it('a URL that wraps is one link on every row, each with the whole address', () => {
    // Row 0 fills the width, so it wrapped into row 1.
    const perRow = detectUrlsAcrossRows(rows('see https:', '//ex.test/a and'), width);
    expect(perRow).toEqual([
      [{ start: 4, end: 10, url: 'https://ex.test/a' }],
      [{ start: 0, end: 11, url: 'https://ex.test/a' }],
    ]);
  });

  it('strips sentence punctuation from the whole URL, not from a row at the wrap', () => {
    const perRow = detectUrlsAcrossRows(rows('https://a.', 'test/x. ok'), width);
    expect(perRow[0]).toEqual([{ start: 0, end: 10, url: 'https://a.test/x' }]);
    expect(perRow[1]).toEqual([{ start: 0, end: 6, url: 'https://a.test/x' }]);
  });

  it('a row that did not fill the width ends its line: the next row is its own', () => {
    const perRow = detectUrlsAcrossRows(rows('https:', '//ex.test/'), width);
    expect(perRow).toEqual([[], []]);
  });

  describe('a URL the program wrapped itself, short of the edge and indented', () => {
    // A 40-column pane; the program wraps at its own box, a few columns in.
    const pane = 40;
    const url = 'https://example.com/docs/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';
    const at = (row: number, perRow: ReturnType<typeof detectUrlsAcrossRows>) =>
      perRow[row].map((m) => m.url);

    it('links every row it covers to the whole address', () => {
      const lines = rows(
        `⏺ See ${url.slice(0, 30)}`, // ends at column 36
        `  ${url.slice(30, 64)}`,
        `  for the details.`,
      );
      const perRow = detectUrlsAcrossRows(lines, pane);
      expect(at(0, perRow)).toEqual([url]);
      expect(at(1, perRow)).toEqual([url]);
      expect(perRow[1][0]).toMatchObject({ start: 2, end: 2 + url.length - 30 });
      expect(at(2, perRow)).toEqual([]);
    });

    it('runs through a box border and across three rows', () => {
      const long = `${url}/more/segments-that-go-on/and-on-and-on/xyz`;
      const lines = rows(
        `│ ${long.slice(0, 34)} │`,
        `│ ${long.slice(34, 68)} │`,
        `│ ${long.slice(68)}`,
      );
      const perRow = detectUrlsAcrossRows(lines, pane);
      for (const row of [0, 1, 2]) expect(at(row, perRow)).toEqual([long]);
    });

    it('keeps a dot the break fell after', () => {
      const lines = rows(`see https://docs.example.com/guide/v2.`, `  html?x=1 ok`);
      expect(at(0, detectUrlsAcrossRows(lines, pane))).toEqual([
        'https://docs.example.com/guide/v2.html?x=1',
      ]);
    });

    it('links a URL agy word-wrapped early at a dot or hyphen because the rest could not fit', () => {
      // agy (glamour / muesli wordwrap) breaks at `.` and `-` when the next
      // slash-separated segment exceeds the remaining width, leaving row 0
      // far short of the right edge (col 36 of an 80-col pane).
      const full = 'https://github.com/flplima/tmuxy/actions/runs/43722362807';
      const agyRows = rows(
        '  • Run 43722362807: https://github.',
        '  com/flplima/tmuxy/actions/runs/43722362807',
      );
      const perRow = detectUrlsAcrossRows(agyRows, 80);
      expect(perRow[0]).toEqual([{ start: 21, end: 36, url: full }]);
      expect(perRow[1]).toEqual([{ start: 2, end: 44, url: full }]);

      // Across three rows, with a hyphen break on row 0 and a slash break on row 1.
      const threeRowUrl =
        'https://my-staging-host.example.com/org/repo/actions/runs/43722362807/job/98765432101234567890';
      const threeRows = rows(
        '  • Job link: https://my-staging-',
        '  host.example.com/org/repo/actions/runs/43722362807/job/',
        '  98765432101234567890',
      );
      const threeDetected = detectUrlsAcrossRows(threeRows, 80);
      for (const r of [0, 1, 2]) expect(at(r, threeDetected)).toEqual([threeRowUrl]);
    });

    it('uses underline continuity from TUI markdown links and stops when underline ends', () => {
      const underlined = (prefix: string, linkPart: string, suffix = ''): CellLine => [
        ...[...prefix].map((c) => ({ c })),
        ...[...linkPart].map((c) => ({ c, s: { underline: true } })),
        ...[...suffix].map((c) => ({ c })),
      ];
      const full = 'https://docs.example.com/reference/configuration/overview';
      const lines = [
        underlined('  • Docs: ', 'https://docs.example.com/reference/configuration/'),
        underlined('  ', 'overview', ' for more details'),
      ];
      const perRow = detectUrlsAcrossRows(lines, 80);
      expect(at(0, perRow)).toEqual([full]);
      expect(at(1, perRow)).toEqual([full]);

      // When row 0's URL is underlined and row 1's text is not, row 1 is not joined
      // even if row 0 reached the margin and row 1 starts with URL-like characters.
      const separate = [
        underlined('see ', 'https://example.com/docs/abcdefghij'),
        rows('  v2.0 is out')[0],
      ];
      expect(at(0, detectUrlsAcrossRows(separate, pane))).toEqual([
        'https://example.com/docs/abcdefghij',
      ]);
    });

    it('runs through a full-width box border and does not merge two consecutive URLs', () => {
      const boxed = rows(
        `│ ${url.slice(0, 36)} │`, // 40 columns === pane
        `│ ${url.slice(36)} │`,
      );
      const perRow = detectUrlsAcrossRows(boxed, pane);
      expect(at(0, perRow)).toEqual([url]);
      expect(at(1, perRow)).toEqual([url]);

      const twoUrls = rows(
        '  https://github.com/flplima/tmuxy/pull/283',
        '  https://github.com/flplima/tmuxy/pull/284',
      );
      const twoDetected = detectUrlsAcrossRows(twoUrls, 45);
      expect(at(0, twoDetected)).toEqual(['https://github.com/flplima/tmuxy/pull/283']);
      expect(at(1, twoDetected)).toEqual(['https://github.com/flplima/tmuxy/pull/284']);
    });

    it('does not run on into a word, a list item, or a row that left room', () => {
      const ending = `see https://example.com/docs/abcdefghij`; // ends at column 39
      for (const next of ['  and the rest of it', '  - next item', '  2. second item']) {
        expect(at(0, detectUrlsAcrossRows(rows(ending, next), pane))).toEqual([
          'https://example.com/docs/abcdefghij',
        ]);
      }
      // Fifteen columns short of the edge: the line ended there.
      expect(
        at(0, detectUrlsAcrossRows(rows('see https://example.com/x', '  /more/path'), pane)),
      ).toEqual(['https://example.com/x']);
    });
  });

  it('rows outside a wrapped line are detected on their own', () => {
    const perRow = detectUrlsAcrossRows(rows('x https://a', 'b.test/1 y', 'https://c.t'), width);
    expect(perRow[0]).toEqual([{ start: 2, end: 11, url: 'https://ab.test/1' }]);
    expect(perRow[1]).toEqual([{ start: 0, end: 8, url: 'https://ab.test/1' }]);
    expect(perRow[2]).toEqual([{ start: 0, end: 11, url: 'https://c.t' }]);
  });
});
