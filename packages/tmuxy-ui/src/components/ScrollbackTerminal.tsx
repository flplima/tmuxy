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
  const prevLinesRef = useRef<
    Map<
      number,
      { line: CellLine; selRange: ReturnType<ReturnType<typeof computeScrollbackSelection>> }
    >
  >(new Map());

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
    const prevMap = prevLinesRef.current;

    // Ensure correct number of line divs
    if (children.length !== visibleCount) {
      pre.textContent = '';
      prevMap.clear();
      for (let i = 0; i < visibleCount; i++) {
        const div = document.createElement('div');
        div.className = 'terminal-line';
        const row = visibleStart + i;
        const line = lines.get(row) ?? EMPTY_LINE;
        const selRange = getSelectionRange(row);
        renderLineToDOM(div, line, selRange);
        pre.appendChild(div);
        prevMap.set(row, { line, selRange });
      }
    } else {
      // Incremental update
      const newPrevMap = new Map<
        number,
        { line: CellLine; selRange: ReturnType<ReturnType<typeof computeScrollbackSelection>> }
      >();
      for (let i = 0; i < visibleCount; i++) {
        const row = visibleStart + i;
        const line = lines.get(row) ?? EMPTY_LINE;
        const selRange = getSelectionRange(row);
        const prev = prevMap.get(row);

        const lineChanged = !prev || prev.line !== line;
        const selChanged =
          !prev ||
          (selRange !== prev.selRange &&
            (selRange === null ||
              prev.selRange === null ||
              selRange?.startCol !== prev.selRange?.startCol ||
              selRange?.endCol !== prev.selRange?.endCol));

        if (lineChanged || selChanged) {
          const div = children[i] as HTMLDivElement;
          renderLineToDOM(div, line, selRange);
        }
        newPrevMap.set(row, { line, selRange });
      }
      prevLinesRef.current = newPrevMap;
    }
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
