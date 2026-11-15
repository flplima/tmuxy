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
const URL_TAIL_RE = new RegExp(`${URL_CHAR}+$`, 'u');
const HAS_SCHEME_RE = /https?:\/\//i;
const STARTS_WITH_SCHEME_RE = /^https?:\/\//i;
/** Characters a word-wrapper (`muesli/reflow/wordwrap`, etc.) breaks a URL after. */
const URL_WRAP_BREAK_RE = /[.\-/?&=:;_~#]/;
/** Closing punctuation/quotes that may immediately follow a URL token at the end of a line. */
const TRAILING_PUNCT_RE = /^['"`>.,;:!?)\]]*$/;
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

function underlineSpanState(
  prevCell: CellLine[number],
  nextCell: CellLine[number],
): 'continued' | 'ended' | 'none' {
  if (!prevCell.s?.underline) return 'none';
  return nextCell.s?.underline ? 'continued' : 'ended';
}

function endsWithUrlFragment(prev: CellLine, before: ReturnType<typeof contentOf>): boolean {
  const prevContent = rowText(prev).slice(before.start, before.end);
  const prevTail = URL_TAIL_RE.exec(prevContent)?.[0];
  if (!prevTail) return false;
  return (
    HAS_SCHEME_RE.test(prevTail) || (before.startCell > 0 && prevTail.length === prevContent.length)
  );
}

/**
 * Whether `prev` ended inside a URL that either reached `edge`, was broken early
 * at `.` / `-` (or another URL delimiter) by a word-wrapper (`muesli/reflow/wordwrap`
 * in agy/glamour) because `token` could not fit before `edge`, or was underlined
 * across both rows by the TUI.
 */
function brokeInsideUrl(
  prev: CellLine,
  before: ReturnType<typeof contentOf>,
  after: ReturnType<typeof contentOf>,
  token: string,
  edge: number,
  bothUnderlined: boolean,
): boolean {
  if (before.endCell >= edge) return true;
  if (!endsWithUrlFragment(prev, before)) return false;
  if (bothUnderlined) return true;
  if (after.startCell === 0) return false;
  const lastChar = prev[before.endCell - 1].c;
  if (/[.-]/.test(lastChar) && URLISH_RE.test(token)) return true;
  return URL_WRAP_BREAK_RE.test(lastChar) && before.endCell + token.length > edge;
}

function isUrlContinuationToken(rest: string, bothUnderlined: boolean): string | null {
  const token = URL_RUN_RE.exec(rest)?.[0];
  if (!token || STARTS_WITH_SCHEME_RE.test(token)) return null;
  const alone = TRAILING_PUNCT_RE.test(rest.slice(token.length));
  if (!alone && LIST_MARKER_RE.test(token)) return null;
  return alone || bothUnderlined || URLISH_RE.test(token) ? token : null;
}

function isProgramBreak(prev: CellLine, next: CellLine, width: number): boolean {
  const before = contentOf(prev);
  const after = contentOf(next);
  return before.endCell < width || before.startCell > 0 || after.startCell >= 2;
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
  const after = contentOf(next);
  if (before.endCell === before.startCell || after.endCell === after.startCell) {
    return false;
  }
  const lastCell = prev[before.endCell - 1];
  if (!URL_CHAR_RE.test(lastCell.c)) return false;
  const underline = underlineSpanState(lastCell, next[after.startCell]);
  if (underline === 'ended') return false;
  const bothUnderlined = underline === 'continued';
  const rest = rowText(next).slice(after.start, after.end);
  const token = isUrlContinuationToken(rest, bothUnderlined);
  if (!token) return false;
  return brokeInsideUrl(prev, before, after, token, width - wrapSlack(width), bothUnderlined);
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
      const brokeBefore = r > i && isProgramBreak(rows[r - 1], rows[r], width);
      const breaksAfter = r < end && isProgramBreak(rows[r], rows[r + 1], width);
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
