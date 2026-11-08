import { isWrappedRow } from '../../domain/copyMode';
import type { CellLine } from '../../domain/wireCells';

export interface DetectedUrl {
  start: number;
  end: number; // exclusive
  url: string;
}

/**
 * Every ASCII character RFC 3986 permits in a URI (unreserved, gen- and
 * sub-delimiters, `%`), plus Unicode letters, digits and marks for
 * internationalised addresses. An allowlist: terminal UIs butt text against
 * separators with no space (`…/bar│Files:12│Status:ok`), and an exclusion
 * class swallowed them.
 */
const URL_CHAR = String.raw`[\p{L}\p{N}\p{M}\-._~:/?#\[\]@!$&'()*+,;=%]`;
const URL_RE = new RegExp(String.raw`https?://${URL_CHAR}+`, 'gu');

/** UTF-16 ranges; trailing sentence punctuation is not part of the URL. */
export function detectUrls(text: string): DetectedUrl[] {
  const results: DetectedUrl[] = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    while (url.length > 1 && /[.,;:!?)\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    results.push({ start: m.index, end: m.index + url.length, url });
  }
  return results;
}

export function rowText(line: CellLine): string {
  let text = '';
  for (const cell of line) text += cell.c;
  return text;
}

const URL_CHAR_RE = new RegExp(`^${URL_CHAR}$`, 'u');
const URL_RUN_RE = new RegExp(`^${URL_CHAR}+`, 'u');
/** A character only an address is likely to carry. */
const URLISH_RE = /[/.?=&%#_~:\-\p{N}]/u;
const LIST_MARKER_RE = /^(?:[-*+•]|\p{N}+[.)])$/u;
/** Blank or box drawing: the margin a program draws around text. */
const MARGIN_RE = /^[\s─-╿]*$/u;
/** A TUI wraps at its own box, padding or border, inside the pane's edge. */
const wrapSlack = (width: number) => Math.min(10, Math.floor(width / 8));

/** Between the margins: cell indices, and UTF-16 offsets into the row's text. */
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
 * Whether `next` may be the rest of an address `prev` ran out of room for,
 * wrapped by the PROGRAM: Claude Code, agy and other Ink and curses TUIs break
 * long lines themselves, at their own width with the continuation indented,
 * so `isWrappedRow` sees two lines. A false positive costs a link that runs a
 * word too far.
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

export function continuesInto(
  prev: CellLine | undefined,
  next: CellLine | undefined,
  width: number,
): boolean {
  return isWrappedRow(prev, width) || mayContinueUrl(prev, next, width);
}

/**
 * URL detection over LOGICAL lines: the rows of one are joined (a program's
 * margin and indentation left out at each break it made) and each match is cut
 * back into per-row ranges, every range carrying the whole URL. Offsets are
 * UTF-16 offsets into each row's own text.
 */
export function detectUrlsAcrossRows(rows: readonly CellLine[], width: number): DetectedUrl[][] {
  const perRow: DetectedUrl[][] = rows.map(() => []);
  let i = 0;
  while (i < rows.length) {
    let end = i;
    while (end < rows.length - 1 && continuesInto(rows[end], rows[end + 1], width)) end++;
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

export function sameUrls(a: readonly DetectedUrl[], b: readonly DetectedUrl[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((u, k) => u.start === b[k].start && u.end === b[k].end && u.url === b[k].url);
}
