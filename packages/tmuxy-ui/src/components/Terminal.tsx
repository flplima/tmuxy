/**
 * Terminal - Renders structured cell content from Rust backend
 *
 * Uses imperative DOM updates for performance: instead of React reconciling
 * 50+ TerminalLine components on every SSE update, we directly patch only
 * the DOM lines whose content actually changed. This eliminates React
 * overhead (diffing, fiber creation, span grouping) and makes full-screen
 * redraws (like neovim) nearly instantaneous.
 *
 * The cursor is rendered as a React overlay to keep its blink animation
 * managed declaratively.
 */

import { useRef, useLayoutEffect, useMemo, memo } from 'react';
import { Cursor } from './Cursor';
import { renderLineToDOM, detectPaneBg } from './terminalRendering';
import { CHAR_HEIGHT } from '../constants';
import type { PaneContent, CellLine } from '../tmux/types';

interface TerminalProps {
  content: PaneContent;
  cursorX?: number;
  cursorY?: number;
  isActive?: boolean;
  blink?: boolean;
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
  /** Backend-provided selection start Y (authoritative, from tmux) */
  selectionStartY?: number;
  /** Character width in pixels (for cursor positioning) */
  charWidth?: number;
  /** Whether the cursor is visible (DECTCEM - hidden during full-screen redraws) */
  cursorVisible?: boolean;
}

// Empty line constant for padding
const EMPTY_LINE: CellLine = [];

// ============================================
// Selection range computation
// ============================================

function computeSelectionRanges(
  selectionPresent: boolean,
  selectionStart: { x: number; y: number } | null | undefined,
  copyCursorX: number,
  copyCursorY: number,
  width: number,
): (lineIndex: number) => { startCol: number; endCol: number } | null {
  if (!selectionPresent || !selectionStart) return () => null;

  let sy = selectionStart.y,
    sx = selectionStart.x;
  let ey = copyCursorY,
    ex = copyCursorX;
  if (sy > ey || (sy === ey && sx > ex)) {
    [sy, sx, ey, ex] = [ey, ex, sy, sx];
  }

  return (lineIndex: number) => {
    if (lineIndex < sy || lineIndex > ey) return null;
    if (sy === ey) return { startCol: sx, endCol: ex };
    if (lineIndex === sy) return { startCol: sx, endCol: width - 1 };
    if (lineIndex === ey) return { startCol: 0, endCol: ex };
    return { startCol: 0, endCol: width - 1 };
  };
}

// ============================================
// Terminal component
// ============================================

export const Terminal: React.FC<TerminalProps> = memo(
  ({
    content,
    cursorX = 0,
    cursorY = 0,
    isActive = false,
    blink,
    width = 80,
    height = 24,
    inMode = false,
    copyCursorX = 0,
    copyCursorY = 0,
    selectionPresent = false,
    selectionStart,
    selectionStartX = 0,
    selectionStartY = 0,
    charWidth,
    cursorVisible = true,
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const preRef = useRef<HTMLPreElement>(null);
    // Track previous lines for diffing (by reference)
    const prevLinesRef = useRef<CellLine[]>([]);
    // Track previous selection ranges for diffing
    const prevSelRef = useRef<(lineIndex: number) => { startCol: number; endCol: number } | null>(
      () => null,
    );

    const effectiveCursorX = inMode ? copyCursorX : cursorX;
    const effectiveCursorY = inMode ? copyCursorY : cursorY;
    const showCursor = isActive || inMode;

    const effectiveSelectionStart = useMemo(() => {
      if (selectionStart) return selectionStart;
      if (selectionPresent) return { x: selectionStartX, y: selectionStartY };
      return null;
    }, [selectionStart, selectionPresent, selectionStartX, selectionStartY]);

    const getSelectionRange = useMemo(
      () =>
        computeSelectionRanges(
          selectionPresent,
          effectiveSelectionStart,
          copyCursorX,
          copyCursorY,
          width,
        ),
      [selectionPresent, effectiveSelectionStart, copyCursorX, copyCursorY, width],
    );

    // Pad content to fill height
    const lines = useMemo(() => {
      const result: CellLine[] = [...content];
      while (result.length < height) result.push(EMPTY_LINE);
      return result.slice(0, height);
    }, [content, height]);

    // Imperative DOM update: only patch lines that changed
    useLayoutEffect(() => {
      const pre = preRef.current;
      if (!pre) return;

      const prevLines = prevLinesRef.current;
      const prevSel = prevSelRef.current;
      const children = pre.children;

      // Ensure we have the right number of line divs
      if (children.length !== lines.length) {
        // Full rebuild (first render or height change)
        pre.textContent = '';
        for (let i = 0; i < lines.length; i++) {
          const div = document.createElement('div');
          div.className = 'terminal-line';
          const selRange = getSelectionRange(i);
          renderLineToDOM(div, lines[i], selRange);
          pre.appendChild(div);
        }
      } else {
        // Incremental update: only re-render changed lines
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const prevLine = prevLines[i];
          const selRange = getSelectionRange(i);
          const prevSelRange = prevSel(i);

          // Skip if line reference and selection haven't changed
          const lineChanged = line !== prevLine;
          const selChanged =
            selRange !== prevSelRange &&
            (selRange === null ||
              prevSelRange === null ||
              selRange.startCol !== prevSelRange.startCol ||
              selRange.endCol !== prevSelRange.endCol);

          if (!lineChanged && !selChanged) continue;

          const div = children[i] as HTMLDivElement;
          renderLineToDOM(div, line, selRange);
        }
      }

      prevLinesRef.current = lines;
      prevSelRef.current = getSelectionRange;

      // Update container background to match the pane's dominant theme bg.
      // Prevents black gaps between rows and ensures empty areas match.
      if (containerRef.current) {
        const paneBg = detectPaneBg(lines);
        containerRef.current.style.backgroundColor = paneBg || '';
      }
    }, [lines, getSelectionRange]);

    // Compute cursor character from content
    const cursorChar = useMemo(() => {
      if (!showCursor) return ' ';
      const line = lines[effectiveCursorY];
      if (!line || effectiveCursorX >= line.length) return ' ';
      return line[effectiveCursorX].c;
    }, [showCursor, lines, effectiveCursorX, effectiveCursorY]);

    return (
      <div
        className="terminal-container"
        data-testid="terminal"
        role="log"
        aria-live="off"
        ref={containerRef}
      >
        <pre className="terminal-content" aria-hidden="true" ref={preRef} />
        {showCursor && charWidth !== undefined && cursorVisible && (
          <Cursor
            x={effectiveCursorX}
            y={effectiveCursorY}
            char={cursorChar}
            copyMode={inMode}
            active={isActive}
            blink={blink}
            mode="block"
            charWidth={charWidth}
            charHeight={CHAR_HEIGHT}
          />
        )}
      </div>
    );
  },
);
