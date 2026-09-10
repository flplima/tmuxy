import { describe, it, expect } from 'vitest';
import { detectUrls } from '../urlDetect';

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
