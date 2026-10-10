/**
 * Auto-detect URLs in terminal line text.
 * Returns ranges of detected URLs for rendering as clickable links.
 */

import { isWrappedRow } from './copyMode';
import type { CellLine } from '../domain/wire';

export interface DetectedUrl {
  start: number;
  end: number; // exclusive
  url: string;
}

/**
 * What a URL is allowed to contain: every ASCII character RFC 3986 permits in
 * a URI — unreserved, the gen- and sub-delimiters, and `%` for escapes — plus
 * Unicode letters, digits and combining marks, so an internationalised
 * address still matches.
 *
 * Defined by what it ADMITS, not by what it excludes. A terminal UI butts its
 * text against separators with no space in between, and a class written the
 * other way round swallowed every one of them — `…/bar│Files:12│Status:ok`,
 * `…/path→next`, `…/a&b=1|next` each came back as a single URL covering most
 * of the line, which is what put a link's highlight over unrelated text.
 */
const URL_CHAR = String.raw`[\p{L}\p{N}\p{M}\-._~:/?#\[\]@!$&'()*+,;=%]`;
const URL_RE = new RegExp(String.raw`https?://${URL_CHAR}+`, 'gu');

/**
 * Find all URLs in a string, returning their character ranges.
 * Strips trailing punctuation that's likely sentence-ending, not part of the URL.
 */
export function detectUrls(text: string): DetectedUrl[] {
  const results: DetectedUrl[] = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    // Strip trailing punctuation (period, comma, etc.)
    while (url.length > 1 && /[.,;:!?)\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    results.push({ start: m.index, end: m.index + url.length, url });
  }
  return results;
}

/** A row's cells joined as text, the way `detectUrls` sees a row. */
export function rowText(line: CellLine): string {
  let text = '';
  for (const cell of line) text += cell.c;
  return text;
}

/**
 * URL detection over LOGICAL lines: a row that filled the pane's width ran on
 * into the next with no line break (`isWrappedRow`), so the rows of one
 * wrapped line are joined before the regex runs and each match is cut back
 * into per-row ranges — every range carrying the whole URL. Detected per row,
 * a long address was a link to its first row's fragment and plain text after
 * that; a scheme straddling the wrap was no link at all.
 *
 * Offsets are UTF-16 offsets into each row's own text, as `detectUrls`
 * reports them for a single row.
 */
export function detectUrlsAcrossRows(rows: readonly CellLine[], width: number): DetectedUrl[][] {
  const perRow: DetectedUrl[][] = rows.map(() => []);
  let i = 0;
  while (i < rows.length) {
    let end = i;
    while (end < rows.length - 1 && isWrappedRow(rows[end], width)) end++;
    const texts = rows.slice(i, end + 1).map(rowText);
    const matches = detectUrls(texts.join(''));
    let base = 0;
    for (let r = i; r <= end; r++) {
      const length = texts[r - i].length;
      for (const m of matches) {
        if (m.end <= base || m.start >= base + length) continue;
        perRow[r].push({
          start: Math.max(m.start - base, 0),
          end: Math.min(m.end - base, length),
          url: m.url,
        });
      }
      base += length;
    }
    i = end + 1;
  }
  return perRow;
}

/** Whether two detections would draw the same links. */
export function sameUrls(a: readonly DetectedUrl[], b: readonly DetectedUrl[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((u, k) => u.start === b[k].start && u.end === b[k].end && u.url === b[k].url);
}
