/**
 * Terminal - Renders structured cell content from Rust backend
 *
 * Uses TerminalLine for efficient per-line memoization.
 * Content is pre-parsed structured cells, not ANSI strings.
 */

import { useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import type { PaneContent, CellLine } from '../tmux/types';

interface TerminalProps {
  content: PaneContent;
  paneId?: number;
  cursorX?: number;
  cursorY?: number;
  isActive?: boolean;
  width?: number;
  height?: number;
  inMode?: boolean; // copy mode
  copyCursorX?: number;
  copyCursorY?: number;
  selectionPresent?: boolean;
  /** Mouse drag selection start (optimistic, immediate feedback) */
  selectionStart?: { x: number; y: number } | null;
  /** Backend-provided selection start X (authoritative, from tmux) */
  selectionStartX?: number;
  /** Backend-provided selection start Y (authoritative, from tmux, visible-relative) */
  selectionStartY?: number;
}

// Empty line constant for padding
const EMPTY_LINE: CellLine = [];

/**
 * Compute per-line selection column ranges.
 * Returns a function that, given a line index, returns { startCol, endCol } or null.
 */
function computeSelectionRanges(
  selectionPresent: boolean,
  selectionStart: { x: number; y: number } | null | undefined,
  copyCursorX: number,
  copyCursorY: number,
  width: number,
): (lineIndex: number) => { startCol: number; endCol: number } | null {
  if (!selectionPresent || !selectionStart) return () => null;

  // Normalize: ensure start is before end
  let sy = selectionStart.y, sx = selectionStart.x;
  let ey = copyCursorY, ex = copyCursorX;
  if (sy > ey || (sy === ey && sx > ex)) {
    [sy, sx, ey, ex] = [ey, ex, sy, sx];
  }

  return (lineIndex: number) => {
    if (lineIndex < sy || lineIndex > ey) return null;

    if (sy === ey) {
      // Single line selection
      return { startCol: sx, endCol: ex };
    }

    if (lineIndex === sy) {
      // First line: from startCol to end of line
      return { startCol: sx, endCol: width - 1 };
    }
    if (lineIndex === ey) {
      // Last line: from start to endCol
      return { startCol: 0, endCol: ex };
    }
    // Middle lines: fully selected
    return { startCol: 0, endCol: width - 1 };
  };
}

export const Terminal: React.FC<TerminalProps> = ({
  content,
  cursorX = 0,
  cursorY = 0,
  isActive = false,
  width = 80,
  height = 24,
  inMode = false,
  copyCursorX = 0,
  copyCursorY = 0,
  selectionPresent = false,
  selectionStart,
  selectionStartX = 0,
  selectionStartY = 0,
}) => {
  // Use copy mode cursor position when in copy mode
  const effectiveCursorX = inMode ? copyCursorX : cursorX;
  const effectiveCursorY = inMode ? copyCursorY : cursorY;
  const showCursor = isActive || inMode;

  // Resolve selection start: mouse drag (optimistic) takes priority, then backend (authoritative)
  const effectiveSelectionStart = useMemo(() => {
    if (selectionStart) return selectionStart;
    if (selectionPresent) return { x: selectionStartX, y: selectionStartY };
    return null;
  }, [selectionStart, selectionPresent, selectionStartX, selectionStartY]);

  // Compute selection ranges for each line
  const getSelectionRange = useMemo(
    () => computeSelectionRanges(selectionPresent, effectiveSelectionStart, copyCursorX, copyCursorY, width),
    [selectionPresent, effectiveSelectionStart, copyCursorX, copyCursorY, width]
  );

  // Pad content to fill height
  const lines = useMemo(() => {
    const result: CellLine[] = [...content];
    while (result.length < height) {
      result.push(EMPTY_LINE);
    }
    return result.slice(0, height);
  }, [content, height]);

  // Extract first line for accessibility (plain text)
  const firstLineText = useMemo(() => {
    if (content.length === 0) return '';
    return content[0].map((cell) => cell.c).join('').trim();
  }, [content]);

  return (
    <div
      className="terminal-container"
      data-testid="terminal"
      data-cursor-x={effectiveCursorX}
      data-cursor-y={effectiveCursorY}
      role="log"
      aria-label={`Terminal output: ${firstLineText.slice(0, 50)}${firstLineText.length > 50 ? '...' : ''}`}
      aria-live="polite"
    >
      <pre className="terminal-content" aria-hidden="true">
        {lines.map((line, lineIndex) => (
          <TerminalLine
            key={lineIndex}
            line={line}
            lineIndex={lineIndex}
            cursorX={effectiveCursorX}
            cursorY={effectiveCursorY}
            showCursor={showCursor}
            inMode={inMode}
            isActive={isActive}
            selectionRange={getSelectionRange(lineIndex)}
          />
        ))}
      </pre>
    </div>
  );
};
