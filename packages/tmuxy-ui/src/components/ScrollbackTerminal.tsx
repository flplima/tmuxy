/**
 * ScrollbackTerminal - Virtual-scrolling terminal renderer for copy mode scrollback
 *
 * Renders loaded scrollback content with virtual scrolling. Only visible AND loaded
 * lines are rendered. Selection is computed client-side from cursor/anchor positions.
 */

import { useCallback, useRef, useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import { useAppSend, useAppSelector, selectCharSize } from '../machines/AppContext';
import type { CopyModeState, CellLine } from '../tmux/types';

interface ScrollbackTerminalProps {
  paneId: string;
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

  let sy = selectionAnchor.row, sx = selectionAnchor.col;
  let ey = cursorRow, ex = cursorCol;
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

export function ScrollbackTerminal({ paneId, copyState }: ScrollbackTerminalProps) {
  const send = useAppSend();
  const { charHeight } = useAppSelector(selectCharSize);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDone = useRef(false);

  const {
    totalLines,
    scrollTop,
    height,
    width,
    cursorRow,
    cursorCol,
    lines,
    loading,
  } = copyState;

  const getSelectionRange = useMemo(
    () => computeScrollbackSelection(copyState),
    [copyState.selectionAnchor, copyState.selectionMode, copyState.cursorRow, copyState.cursorCol, copyState.width]
  );

  // Visible line range
  const visibleStart = scrollTop;
  const visibleEnd = Math.min(totalLines - 1, scrollTop + height - 1);

  // Handle native scroll (viewport only - does not move cursor or selection)
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const newScrollTop = Math.floor(target.scrollTop / charHeight);
    send({
      type: 'COPY_MODE_SCROLL',
      paneId,
      scrollTop: newScrollTop,
    });
  }, [send, paneId, charHeight]);

  // Sync container scroll position when scrollTop changes from keyboard/wheel
  const lastScrollTop = useRef(scrollTop);
  if (containerRef.current && scrollTop !== lastScrollTop.current) {
    containerRef.current.scrollTop = scrollTop * charHeight;
    lastScrollTop.current = scrollTop;
  }

  // Callback ref to set initial scroll position on mount
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node && !initialScrollDone.current) {
      node.scrollTop = scrollTop * charHeight;
      initialScrollDone.current = true;
    }
  }, [scrollTop, charHeight]);

  // Build visible lines
  const visibleLines: Array<{ absoluteRow: number; line: CellLine }> = [];
  for (let row = visibleStart; row <= visibleEnd; row++) {
    const line = lines.get(row);
    visibleLines.push({ absoluteRow: row, line: line ?? EMPTY_LINE });
  }

  const totalHeight = totalLines * charHeight;
  const isCursorVisible = cursorRow >= visibleStart && cursorRow <= visibleEnd;

  return (
    <div
      className="terminal-container scrollback-terminal hide-scrollbar"
      data-testid="scrollback-terminal"
      data-copy-mode="true"
      ref={setContainerRef}
      onScroll={handleScroll}
      style={{
        overflowY: 'auto',
        position: 'relative',
        height: '100%',
      }}
    >
      {/* Full-height spacer for scrollbar */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        <pre
          className="terminal-content"
          aria-hidden="true"
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
      </div>
      {loading && (
        <div className="scrollback-loading" style={{
          position: 'absolute',
          top: 4,
          right: 8,
          fontSize: '0.75rem',
          opacity: 0.6,
          color: 'var(--fg, #cdd6f4)',
        }}>
          Loading...
        </div>
      )}
    </div>
  );
}
