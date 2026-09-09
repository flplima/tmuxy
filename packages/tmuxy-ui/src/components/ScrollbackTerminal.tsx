/**
 * ScrollbackTerminal - Virtual-scrolling renderer for a pane's scrollback
 *
 * Renders loaded scrollback content as a positioned <pre> block inside Pane's
 * shared scroll container. Only visible AND loaded lines are rendered.
 * Uses imperative DOM updates via terminalRendering.ts. NOTE: this is a
 * SEPARATE renderer from Terminal's React-based TerminalLine.tsx — the two
 * implementations must be kept in sync manually (styles, selection, cursor).
 * Copy mode's selection is computed client-side from cursor/anchor
 * positions; the scroll view's is the browser's, and the rows it spans stay
 * mounted for as long as it lasts.
 */

import { useRef, useLayoutEffect, useMemo } from 'react';
import { Cursor } from './Cursor';
import { useAppSelector, selectCharSize } from '../machines/AppContext';
import { renderLineToDOM } from './terminalRendering';
import { isRowLoaded } from '../utils/copyMode';
import type { CopyModeState, CellLine } from '../tmux/types';

interface ScrollbackTerminalProps {
  copyState: CopyModeState;
  /** Whether the pane holds the keyboard; only then is the copy cursor drawn. */
  isActive: boolean;
}

/**
 * The scroll view draws no cursor and paints no selection of its own: the
 * browser owns selecting there, the way it does in a native terminal. Copy
 * mode keeps both, because its cursor IS the selection's moving end.
 */

const EMPTY_LINE: CellLine = [];

// Dim "loading" placeholder for rows that exist in `totalLines` but haven't
// been fetched yet. Distinguishing this from a genuinely blank scrollback row
// (`EMPTY_LINE`) is critical — without it, a slow or failed
// FETCH_SCROLLBACK_CELLS makes the entire history look empty, which is the
// reported symptom of "scrolling up shows only what was already visible".
const PLACEHOLDER_LINE: CellLine = [
  { c: '·', s: { dim: true } },
  { c: ' ' },
  { c: '·', s: { dim: true } },
  { c: ' ' },
  { c: '·', s: { dim: true } },
];

/**
 * Pick the line to render for a row. A row is one of three things:
 *   1. Loaded with content     → render `lines.get(row)`
 *   2. Loaded but blank        → render `EMPTY_LINE`
 *   3. Not yet loaded (in flight or queued) → render `PLACEHOLDER_LINE`
 * The third case used to render as case 2, indistinguishable from a real
 * blank line; users assumed there was no scrollback when in fact a fetch
 * was still pending. `isRowLoaded` checks the `loadedRanges` intervals.
 */
function lineFor(
  row: number,
  lines: Map<number, CellLine>,
  loadedRanges: Array<[number, number]>,
): CellLine {
  const existing = lines.get(row);
  if (existing) return existing;
  return isRowLoaded(loadedRanges, row) ? EMPTY_LINE : PLACEHOLDER_LINE;
}

/** The only `CopyModeState` fields selection geometry depends on. */
type SelectionInput = Pick<
  CopyModeState,
  'selectionAnchor' | 'selectionMode' | 'cursorRow' | 'cursorCol' | 'width'
>;

/**
 * Compute per-line selection ranges from copy mode state
 */
function computeScrollbackSelection(
  state: SelectionInput,
): (lineIndex: number) => { startCol: number; endCol: number } | null {
  const { selectionAnchor, selectionMode, cursorRow, cursorCol, width } = state;
  if (!selectionAnchor || !selectionMode) return () => null;

  const isLineMode = selectionMode === 'line';

  let sy = selectionAnchor.row,
    sx = selectionAnchor.col;
  let ey = cursorRow,
    ex = cursorCol;
  if (sy > ey || (sy === ey && sx > ex)) {
    [sy, sx, ey, ex] = [ey, ex, sy, sx];
  }

  return (absoluteRow: number) => {
    if (absoluteRow < sy || absoluteRow > ey) return null;

    if (isLineMode) {
      return { startCol: 0, endCol: width - 1 };
    }

    if (sy === ey) {
      return { startCol: sx, endCol: ex };
    }

    if (absoluteRow === sy) return { startCol: sx, endCol: width - 1 };
    if (absoluteRow === ey) return { startCol: 0, endCol: ex };
    return { startCol: 0, endCol: width - 1 };
  };
}

type SelRange = ReturnType<ReturnType<typeof computeScrollbackSelection>>;

const sameRange = (a: SelRange, b: SelRange): boolean =>
  a === b || (a !== null && b !== null && a.startCol === b.startCol && a.endCol === b.endCol);

/** The absolute row a selection endpoint sits in, if it is one of ours. */
function rowOf(pre: HTMLElement, node: Node, offset: number): number | null {
  // A range that starts or ends on the <pre> itself addresses a child by index.
  const target =
    node === pre ? (pre.childNodes[Math.min(offset, pre.childNodes.length - 1)] ?? null) : node;
  const element = target instanceof Element ? target : (target?.parentElement ?? null);
  const line = element?.closest<HTMLElement>('.terminal-line') ?? null;
  if (!line || !pre.contains(line)) return null;
  const row = Number(line.dataset.row);
  return Number.isFinite(row) ? row : null;
}

/**
 * The rows the browser's selection spans inside this scrollback, or null
 * when nothing of ours is selected.
 */
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

export function ScrollbackTerminal({ copyState, isActive }: ScrollbackTerminalProps) {
  const { charHeight } = useAppSelector(selectCharSize);
  const preRef = useRef<HTMLPreElement>(null);
  // Mounted rows by absolute row, with what each was last painted with.
  // Every row is positioned at its own `row * charHeight`, so any subset can
  // be mounted and a row is never repainted because the window moved — only
  // when its content changes. That is what keeps the browser's selection
  // alive in the scroll view: its endpoints live in these nodes, and a node
  // that is replaced takes the selection with it.
  const rowsRef = useRef(
    new Map<number, { el: HTMLDivElement; line: CellLine; selRange: SelRange }>(),
  );

  const { totalLines, scrollTop, height, cursorRow, cursorCol, lines, loadedRanges } = copyState;
  const { selectionAnchor, selectionMode, width, mode } = copyState;
  const isCopyMode = mode === 'copy';

  const getSelectionRange = useMemo(
    () =>
      isCopyMode
        ? computeScrollbackSelection({
            selectionAnchor,
            selectionMode,
            cursorRow,
            cursorCol,
            width,
          })
        : () => null,
    [isCopyMode, selectionAnchor, selectionMode, cursorRow, cursorCol, width],
  );

  // Visible line range with overscan buffer (1 screen above + 1 screen below)
  const renderStart = Math.max(0, scrollTop - height);
  const renderEnd = Math.min(totalLines - 1, scrollTop + 2 * height - 1);

  const isCursorVisible =
    isCopyMode && isActive && cursorRow >= renderStart && cursorRow <= renderEnd;

  // Imperative DOM update
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const rows = rowsRef.current;

    // In the scroll view the selection is the browser's: every row it spans
    // stays mounted while the window moves on, so the selection survives the
    // scroll and still reads back whole (selection text is document order,
    // and an unmounted row would simply be missing from it).
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

    const ensure = (row: number) => {
      const line = lineFor(row, lines, loadedRanges);
      const selRange = getSelectionRange(row);
      const top = `${row * charHeight}px`;
      const entry = rows.get(row);
      if (entry) {
        if (entry.el.style.top !== top) entry.el.style.top = top;
        if (entry.line !== line || !sameRange(entry.selRange, selRange)) {
          renderLineToDOM(entry.el, line, selRange);
          entry.line = line;
          entry.selRange = selRange;
        }
        return;
      }
      const el = document.createElement('div');
      el.className = 'terminal-line';
      el.dataset.row = String(row);
      el.style.position = 'absolute';
      el.style.top = top;
      el.style.left = '0';
      el.style.right = '0';
      renderLineToDOM(el, line, selRange);
      // Document order is selection order: keep the rows ascending.
      let next: Element | null = null;
      for (const child of pre.children) {
        if (Number((child as HTMLElement).dataset.row) > row) {
          next = child;
          break;
        }
      }
      pre.insertBefore(el, next);
      rows.set(row, { el, line, selRange });
    };

    for (let row = renderStart; row <= renderEnd; row++) ensure(row);
    if (held) for (let row = held.start; row <= held.end; row++) ensure(row);
  }, [renderStart, renderEnd, lines, loadedRanges, getSelectionRange, isCopyMode, charHeight]);

  // Cursor character
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
      }}
    >
      <pre
        className={`terminal-content ${isCopyMode ? '' : 'terminal-selectable'}`}
        aria-hidden="true"
        data-testid="scrollback-terminal"
        data-copy-mode={isCopyMode ? 'true' : undefined}
        data-scroll-mode={isCopyMode ? undefined : 'true'}
        ref={preRef}
        style={{ position: 'relative', height: '100%' }}
      />
      {isCursorVisible && (
        <Cursor x={cursorCol} y={cursorRow} char={cursorChar} copyMode={true} mode="block" />
      )}
    </div>
  );
}
