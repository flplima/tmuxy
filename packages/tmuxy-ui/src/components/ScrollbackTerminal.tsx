/**
 * ScrollbackTerminal - Virtual-scrolling terminal renderer for copy mode scrollback
 *
 * Renders loaded scrollback content as positioned <pre> blocks inside Pane's
 * shared scroll container. Only visible AND loaded lines are rendered.
 * Selection is computed client-side from cursor/anchor positions.
 */

import { useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import { useAppSelector, selectCharSize } from '../machines/AppContext';
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
  const { charHeight } = useAppSelector(selectCharSize);

  const { totalLines, scrollTop, height, width, cursorRow, cursorCol, lines } = copyState;

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

  // Visible line range
  const visibleStart = scrollTop;
  const visibleEnd = Math.min(totalLines - 1, scrollTop + height - 1);

  // Build visible lines
  const visibleLines: Array<{ absoluteRow: number; line: CellLine }> = [];
  for (let row = visibleStart; row <= visibleEnd; row++) {
    const line = lines.get(row);
    visibleLines.push({ absoluteRow: row, line: line ?? EMPTY_LINE });
  }

  const isCursorVisible = cursorRow >= visibleStart && cursorRow <= visibleEnd;

  return (
    <>
      <pre
        className="terminal-content"
        aria-hidden="true"
        data-testid="scrollback-terminal"
        data-copy-mode="true"
        style={{
          position: 'absolute',
          top: visibleStart * charHeight,
          left: 0,
          right: 0,
        }}
      >
        {visibleLines.map(({ absoluteRow, line }) => (
          <TerminalLine
            key={absoluteRow}
            line={line}
            lineIndex={absoluteRow}
            cursorX={cursorCol}
            cursorY={cursorRow}
            showCursor={isCursorVisible}
            inMode={true}
            isActive={true}
            selectionRange={getSelectionRange(absoluteRow)}
            width={width}
          />
        ))}
      </pre>
    </>
  );
}
