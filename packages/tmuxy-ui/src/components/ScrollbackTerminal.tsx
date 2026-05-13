/**
 * ScrollbackTerminal - Virtual-scrolling terminal renderer for copy mode scrollback
 *
 * Renders loaded scrollback content as a positioned <pre> block inside Pane's
 * shared scroll container. Only visible AND loaded lines are rendered.
 * Uses imperative DOM updates (same as Terminal) for consistent performance.
 * Selection is computed client-side from cursor/anchor positions.
 */

import { useRef, useLayoutEffect, useMemo } from 'react';
import { Cursor } from './Cursor';
import { useAppSelector, selectCharSize } from '../machines/AppContext';
import { renderLineToDOM } from './terminalRendering';
import type { CopyModeState, CellLine } from '../tmux/types';

interface ScrollbackTerminalProps {
  copyState: CopyModeState;
}

const EMPTY_LINE: CellLine = [];

/**
 * Compute per-line selection ranges from copy mode state
 */
function computeScrollbackSelection(
  state: CopyModeState,
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

export function ScrollbackTerminal({ copyState }: ScrollbackTerminalProps) {
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const preRef = useRef<HTMLPreElement>(null);
  // Indexed by div position (not by absolute row): each entry records what
  // was last rendered into children[i]. Position-keyed tracking is required
  // because scrolling shifts visibleStart, reusing the same divs for different
  // rows. A row-keyed map skipped updates whenever the new row happened to
  // overlap the previous render's row set, leaving stale content in the divs.
  const prevLinesRef = useRef<
    Array<{
      row: number;
      line: CellLine;
      selRange: ReturnType<ReturnType<typeof computeScrollbackSelection>>;
    }>
  >([]);

  const { totalLines, scrollTop, height, cursorRow, cursorCol, lines } = copyState;

  const getSelectionRange = useMemo(
    () => computeScrollbackSelection(copyState),
    [
      copyState.selectionAnchor,
      copyState.selectionMode,
      copyState.cursorRow,
      copyState.cursorCol,
      copyState.width,
    ],
  );

  // Visible line range with overscan buffer (1 screen above + 1 screen below)
  const renderStart = Math.max(0, scrollTop - height);
  const renderEnd = Math.min(totalLines - 1, scrollTop + 2 * height - 1);
  const visibleStart = renderStart;
  const visibleEnd = renderEnd;
  const visibleCount = visibleEnd - visibleStart + 1;

  const isCursorVisible = cursorRow >= visibleStart && cursorRow <= visibleEnd;

  // Imperative DOM update
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre) return;

    const children = pre.children;
    const prevArr = prevLinesRef.current;
    const newPrevArr: typeof prevArr = new Array(visibleCount);

    // Ensure correct number of line divs
    if (children.length !== visibleCount) {
      pre.textContent = '';
      for (let i = 0; i < visibleCount; i++) {
        const div = document.createElement('div');
        div.className = 'terminal-line';
        const row = visibleStart + i;
        const line = lines.get(row) ?? EMPTY_LINE;
        const selRange = getSelectionRange(row);
        renderLineToDOM(div, line, selRange);
        pre.appendChild(div);
        newPrevArr[i] = { row, line, selRange };
      }
    } else {
      // Incremental update — compare per div position. When scrolling, the
      // row at children[i] changes; rowChanged forces a redraw even if the
      // new row's content happens to be reference-equal to what was at i
      // before.
      for (let i = 0; i < visibleCount; i++) {
        const row = visibleStart + i;
        const line = lines.get(row) ?? EMPTY_LINE;
        const selRange = getSelectionRange(row);
        const prev = prevArr[i];

        const rowChanged = !prev || prev.row !== row;
        const lineChanged = !prev || prev.line !== line;
        const selChanged =
          !prev ||
          (selRange !== prev.selRange &&
            (selRange === null ||
              prev.selRange === null ||
              selRange?.startCol !== prev.selRange?.startCol ||
              selRange?.endCol !== prev.selRange?.endCol));

        if (rowChanged || lineChanged || selChanged) {
          const div = children[i] as HTMLDivElement;
          renderLineToDOM(div, line, selRange);
        }
        newPrevArr[i] = { row, line, selRange };
      }
    }
    prevLinesRef.current = newPrevArr;
  }, [visibleStart, visibleCount, lines, getSelectionRange]);

  // Cursor character
  const cursorChar = useMemo(() => {
    if (!isCursorVisible) return ' ';
    const line = lines.get(cursorRow);
    if (!line || cursorCol >= line.length) return ' ';
    return line[cursorCol].c;
  }, [isCursorVisible, lines, cursorRow, cursorCol]);

  // Cursor position relative to the <pre> block (not absolute row)
  const cursorRelY = cursorRow - renderStart;

  return (
    <div
      style={{
        position: 'absolute',
        top: renderStart * charHeight,
        left: 0,
        right: 0,
      }}
    >
      <pre
        className="terminal-content"
        aria-hidden="true"
        data-testid="scrollback-terminal"
        data-copy-mode="true"
        ref={preRef}
        style={{ position: 'relative' }}
      />
      {isCursorVisible && (
        <Cursor
          x={cursorCol}
          y={cursorRelY}
          char={cursorChar}
          copyMode={true}
          active={true}
          mode="block"
          charWidth={charWidth}
          charHeight={charHeight}
        />
      )}
    </div>
  );
}
