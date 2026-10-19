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

const URL_CHAR_RE = new RegExp(`^${URL_CHAR}$`, 'u');
const URL_RUN_RE = new RegExp(`^${URL_CHAR}+`, 'u');
/** A character only an address is likely to carry: a word is not one. */
const URLISH_RE = /[/.?=&%#_~:\-\p{N}]/u;
/** What a list item opens with, which never continues the line above it. */
const LIST_MARKER_RE = /^(?:[-*+•]|\p{N}+[.)])$/u;
/** Blank or box drawing: the margin and indentation a program draws around text. */
const MARGIN_RE = /^[\s─-╿]*$/u;
/**
 * How far short of the pane's last column a program may wrap its text: a TUI
 * wraps at its own box, a padding or a border inside the pane's edge — ten
 * columns at most, an eighth of a narrow pane.
 */
const wrapSlack = (width: number) => Math.min(10, Math.floor(width / 8));

/** A row's content between its margins: the cells, and the UTF-16 offsets into its text. */
function contentOf(line: CellLine): {
  startCell: number;
  endCell: number;
  start: number;
  end: number;
} {
  let startCell = 0;
  while (startCell < line.length && MARGIN_RE.test(line[startCell].c)) startCell++;
  let endCell = line.length;
  while (endCell > startCell && MARGIN_RE.test(line[endCell - 1].c)) endCell--;
  let start = 0;
  let end = 0;
  for (let i = 0; i < endCell; i++) {
    if (i < startCell) start += line[i].c.length;
    end += line[i].c.length;
  }
  return { startCell, endCell, start, end };
}

/**
 * Whether `next` may be the rest of an address `prev` ran out of room for —
 * wrapped by the PROGRAM rather than the terminal. Claude Code, agy and the
 * other Ink and curses TUIs break a long line themselves, at their own width
 * and with the continuation indented, so neither row fills the pane and
 * `isWrappedRow` sees two lines. Such a row ends close to the pane's edge, in
 * the middle of a run of URL characters, and the row after it opens (past
 * its indentation) with more of them — characters only an address is likely
 * to carry, or nothing else on the row. A list item opening the next row is
 * never a continuation. When the rows only looked like this, the cost is a
 * link that runs a word too far; the regex still needs a scheme to link
 * anything at all.
 */
export function mayContinueUrl(
  prev: CellLine | undefined,
  next: CellLine | undefined,
  width: number,
): boolean {
  if (!prev || !next) return false;
  const before = contentOf(prev);
  if (before.endCell === before.startCell || before.endCell < width - wrapSlack(width)) {
    return false;
  }
  if (!URL_CHAR_RE.test(prev[before.endCell - 1].c)) return false;
  const after = contentOf(next);
  const rest = rowText(next).slice(after.start, after.end);
  const token = URL_RUN_RE.exec(rest)?.[0];
  if (!token) return false;
  const alone = token.length === rest.length;
  if (!alone && LIST_MARKER_RE.test(token)) return false;
  return alone || URLISH_RE.test(token);
}

/** Whether row `prev` runs on into `next`, as far as an address is concerned. */
export function continuesInto(
  prev: CellLine | undefined,
  next: CellLine | undefined,
  width: number,
): boolean {
  return isWrappedRow(prev, width) || mayContinueUrl(prev, next, width);
}

/**
 * URL detection over LOGICAL lines. A row that filled the pane's width ran on
 * into the next with no line break (`isWrappedRow`), and a row a program
 * wrapped itself may have too (`mayContinueUrl`): the rows of one such line
 * are joined before the regex runs — a program's margin and indentation left
 * out at each break it made — and each match is cut back into per-row ranges,
 * every range carrying the whole URL. Detected per row, a long address was a
 * link to its first row's fragment and plain text after that; a scheme
 * straddling the wrap was no link at all.
 *
 * Offsets are UTF-16 offsets into each row's own text, as `detectUrls`
 * reports them for a single row.
 */
export function detectUrlsAcrossRows(rows: readonly CellLine[], width: number): DetectedUrl[][] {
  const perRow: DetectedUrl[][] = rows.map(() => []);
  let i = 0;
  while (i < rows.length) {
    let end = i;
    while (end < rows.length - 1 && continuesInto(rows[end], rows[end + 1], width)) end++;
    // Each row's part of the joined text: all of it across a terminal wrap,
    // its content between the margins across a break the program made.
    const pieces: Array<{ row: number; text: string; from: number }> = [];
    for (let r = i; r <= end; r++) {
      const text = rowText(rows[r]);
      const content = contentOf(rows[r]);
      const brokeBefore = r > i && !isWrappedRow(rows[r - 1], width);
      const breaksAfter = r < end && !isWrappedRow(rows[r], width);
      const from = brokeBefore ? content.start : 0;
      const to = breaksAfter ? content.end : text.length;
      pieces.push({ row: r, text: text.slice(from, to), from });
    }
    const matches = detectUrls(pieces.map((p) => p.text).join(''));
    let base = 0;
    for (const piece of pieces) {
      const length = piece.text.length;
      for (const m of matches) {
        if (m.end <= base || m.start >= base + length) continue;
        perRow[piece.row].push({
          start: piece.from + Math.max(m.start - base, 0),
          end: piece.from + Math.min(m.end - base, length),
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
