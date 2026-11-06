/**
 * The scroll view draws no cursor: selecting there is the browser's, the way it
 * is in a native terminal. Copy mode keeps the cursor, because it IS the
 * selection's moving end. The painted selection belongs to both — select-all
 * (Cmd+A) puts a client selection on the scroll view, where the browser has no
 * nodes to select for the history that is off screen.
 */

import { useRef, useLayoutEffect, useMemo } from 'react';
import { Cursor } from './Cursor';
import { useAppSelector } from '../../machines/appHooks';
import { selectCharSize } from '../../machines/selectors/layout';
import { renderLineToDOM } from './terminalRendering';
import { cellsToCss, resolveImageSrc, sameCellStyle } from './terminalShared';
import {
  isRowLoaded,
  isWrappedRow,
  selectionColumns,
  type CopyModeState,
} from '../../domain/copyMode';
import { continuesInto, detectUrlsAcrossRows, sameUrls, type DetectedUrl } from './urlDetect';
import { setLinkHot } from './linkHover';
import type { ImagePlacement } from '../../domain/client';
import type { PaneId } from '../../domain/ids';
import type { CellLine } from '../../domain/wireCells';
import {
  dot,
  TERMINAL_CONTENT,
  TERMINAL_LINE,
  TERMINAL_SELECTABLE,
} from '../../infra/dom/terminalDom';

interface ScrollbackTerminalProps {
  copyState: CopyModeState;
  isActive: boolean;
  /** Live rows >= 0, scrollback rows < 0. */
  images?: ImagePlacement[];
  paneId?: PaneId;
}

const EMPTY_LINE: CellLine = [];

// A row not fetched yet must not look like a blank row, or a slow or failed
// fetch makes the whole history look empty.
const PLACEHOLDER_LINE: CellLine = [
  { c: '·', s: { dim: true } },
  { c: ' ' },
  { c: '·', s: { dim: true } },
  { c: ' ' },
  { c: '·', s: { dim: true } },
];

function lineFor(
  row: number,
  lines: Map<number, CellLine>,
  loadedRanges: Array<[number, number]>,
): CellLine {
  const existing = lines.get(row);
  if (existing) return existing;
  return isRowLoaded(loadedRanges, row) ? EMPTY_LINE : PLACEHOLDER_LINE;
}

type SelRange = ReturnType<ReturnType<typeof selectionColumns>>;

const sameRange = (a: SelRange, b: SelRange): boolean =>
  a === b || (a !== null && b !== null && a.startCol === b.startCol && a.endCol === b.endCol);

function setWrapped(el: HTMLElement, wrapped: 'true' | null): void {
  if (wrapped) el.setAttribute('data-wrapped', wrapped);
  else el.removeAttribute('data-wrapped');
}

/**
 * A chunk overlapping loaded rows hands them over as new arrays with the same
 * cells; repainting for that would replace the nodes a selection endpoint sits in.
 */
function sameLine(a: CellLine, b: CellLine): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].c !== b[i].c || !sameCellStyle(a[i].s, b[i].s)) return false;
  }
  return true;
}

function rowOf(pre: HTMLElement, node: Node, offset: number): number | null {
  // A DOM Range boundary on the <pre> itself addresses a child by index.
  const target =
    node === pre ? (pre.childNodes[Math.min(offset, pre.childNodes.length - 1)] ?? null) : node;
  const element = target instanceof Element ? target : (target?.parentElement ?? null);
  const line = element?.closest<HTMLElement>(dot(TERMINAL_LINE)) ?? null;
  if (!line || !pre.contains(line)) return null;
  const row = Number(line.dataset.row);
  return Number.isFinite(row) ? row : null;
}

function selectedRowSpan(pre: HTMLElement): { start: number; end: number } | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const a = rowOf(pre, range.startContainer, range.startOffset);
  const b = rowOf(pre, range.endContainer, range.endOffset);
  if (a === null || b === null) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function ScrollbackTerminal({
  copyState,
  isActive,
  images,
  paneId,
}: ScrollbackTerminalProps) {
  const { charHeight } = useAppSelector(selectCharSize);
  const preRef = useRef<HTMLPreElement>(null);
  // Each row is positioned at its own `row * charHeight` and repainted only
  // when its content changes: the browser's selection has its endpoints in
  // these nodes, and a replaced node takes the selection with it.
  const rowsRef = useRef(
    new Map<
      number,
      { el: HTMLDivElement; line: CellLine; selRange: SelRange; urls: DetectedUrl[] }
    >(),
  );

  const { totalLines, scrollTop, height, cursorRow, cursorCol, lines, loadedRanges } = copyState;
  const { selectionAnchor, selectionMode, width, mode, historySize } = copyState;
  const isCopyMode = mode === 'copy';

  const getSelectionRange = useMemo(
    () =>
      selectionAnchor && selectionMode
        ? selectionColumns(
            selectionAnchor,
            { row: cursorRow, col: cursorCol },
            width,
            selectionMode === 'line',
          )
        : () => null,
    [selectionAnchor, selectionMode, cursorRow, cursorCol, width],
  );

  const renderStart = Math.max(0, scrollTop - height);
  const renderEnd = Math.min(totalLines - 1, scrollTop + 2 * height - 1);

  const isCursorVisible =
    isCopyMode && isActive && cursorRow >= renderStart && cursorRow <= renderEnd;

  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const rows = rowsRef.current;

    // Every row the browser's selection spans stays mounted: its text is read
    // in document order, and an unmounted row would be missing from it.
    const held = isCopyMode ? null : selectedRowSpan(pre);
    const wanted = (row: number) =>
      (row >= renderStart && row <= renderEnd) ||
      (held !== null && row >= held.start && row <= held.end);

    for (const [row, entry] of rows) {
      if (!wanted(row)) {
        entry.el.remove();
        rows.delete(row);
      }
    }

    // Links are detected over the whole logical line the row is part of.
    const runsOn = (row: number) =>
      continuesInto(
        lineFor(row, lines, loadedRanges),
        lineFor(row + 1, lines, loadedRanges),
        width,
      );
    const urlsFor = (row: number, line: CellLine): DetectedUrl[] => {
      let first = row;
      while (first > 0 && runsOn(first - 1)) first--;
      let last = row;
      while (last < totalLines - 1 && runsOn(last)) last++;
      if (first === last) return detectUrlsAcrossRows([line], width)[0];
      const group: CellLine[] = [];
      for (let r = first; r <= last; r++) group.push(lineFor(r, lines, loadedRanges));
      return detectUrlsAcrossRows(group, width)[row - first];
    };

    const ensure = (row: number) => {
      const line = lineFor(row, lines, loadedRanges);
      const selRange = getSelectionRange(row);
      const urls = urlsFor(row, line);
      const top = `${row * charHeight}px`;
      // The browser selection's copy path (infra/dom/nativeSelection.ts) reads
      // this to join soft-wrapped rows rather than break at the pane's width.
      const wrapped = isWrappedRow(line, width) ? 'true' : null;
      const entry = rows.get(row);
      if (entry) {
        if (entry.el.style.top !== top) entry.el.style.top = top;
        setWrapped(entry.el, wrapped);
        if (
          !sameLine(entry.line, line) ||
          !sameRange(entry.selRange, selRange) ||
          !sameUrls(entry.urls, urls)
        ) {
          renderLineToDOM(entry.el, line, selRange, urls);
          entry.selRange = selRange;
          entry.urls = urls;
        }
        entry.line = line;
        return;
      }
      const el = document.createElement('div');
      el.className = TERMINAL_LINE;
      el.dataset.row = String(row);
      setWrapped(el, wrapped);
      el.style.position = 'absolute';
      el.style.top = top;
      el.style.left = '0';
      el.style.right = '0';
      renderLineToDOM(el, line, selRange, urls);
      // The browser's selection follows document order: keep rows ascending.
      let next: Element | null = null;
      for (const child of pre.children) {
        if (Number((child as HTMLElement).dataset.row) > row) {
          next = child;
          break;
        }
      }
      pre.insertBefore(el, next);
      rows.set(row, { el, line, selRange, urls });
    };

    for (let row = renderStart; row <= renderEnd; row++) ensure(row);
    if (held) for (let row = held.start; row <= held.end; row++) ensure(row);
  }, [
    renderStart,
    renderEnd,
    lines,
    loadedRanges,
    getSelectionRange,
    isCopyMode,
    charHeight,
    width,
    totalLines,
  ]);

  const cursorChar = useMemo(() => {
    if (!isCursorVisible) return ' ';
    const line = lines.get(cursorRow);
    if (!line || cursorCol >= line.length) return ' ';
    return line[cursorCol].c;
  }, [isCursorVisible, lines, cursorRow, cursorCol]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: totalLines * charHeight,
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--tmuxy-font-size, 15px)',
        overflow: 'hidden',
      }}
    >
      <pre
        className={`${TERMINAL_CONTENT} ${isCopyMode ? '' : TERMINAL_SELECTABLE}`}
        aria-hidden="true"
        onMouseOver={(e) => setLinkHot(e.target, true)}
        onMouseOut={(e) => setLinkHot(e.target, false)}
        data-testid="scrollback-terminal"
        data-copy-mode={isCopyMode ? 'true' : undefined}
        data-scroll-mode={isCopyMode ? undefined : 'true'}
        // The copy blink: styles/pane-layout.css (infra/dom/copyFlash.ts).
        data-copied={copyState.copiedAt ? 'true' : undefined}
        ref={preRef}
        style={{ position: 'relative', height: '100%' }}
      />
      {isCursorVisible && (
        <Cursor x={cursorCol} y={cursorRow} char={cursorChar} copyMode={true} mode="block" />
      )}
      {images && images.length > 0 && paneId && (
        <div className="terminal-images">
          {images.map((img) => {
            const absRow = historySize + img.row;
            if (absRow + img.heightCells <= 0 || absRow >= totalLines) return null;
            return (
              <img
                key={img.id}
                className="terminal-image"
                src={resolveImageSrc(paneId, img.id)}
                alt=""
                data-protocol={img.protocol}
                data-image-id={img.id}
                style={{
                  position: 'absolute',
                  top: `calc(${absRow} * var(--line-height-terminal))`,
                  left: cellsToCss(img.col),
                  width: cellsToCss(img.widthCells),
                  height: `calc(${img.heightCells} * var(--line-height-terminal))`,
                  objectFit: img.stretch ? 'fill' : undefined,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
