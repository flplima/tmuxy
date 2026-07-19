/**
 * TerminalLine - Memoized terminal line component
 *
 * Renders pre-parsed cell data from Rust backend.
 * Only re-renders when:
 * - Line content changes
 * - Cursor moves to/from this line
 * - Cursor X position changes (when cursor is on this line)
 */

import { memo, useMemo, useCallback, CSSProperties } from 'react';
import { Cursor } from './Cursor';
import { LogProfiler } from '../utils/renderLog';
import type { CursorMode } from './Cursor';
import type { CellLine, TerminalCell, CellStyle } from '../tmux/types';
import { cellColorToCss, isWideChar } from './terminalShared';
import { detectUrls } from '../utils/urlDetect';

/**
 * Compute a numeric key for grouping cells by style.
 * Uses a FNV-1a-inspired hash of the style properties to avoid JSON.stringify.
 */
function styleKey(s: CellStyle | undefined): number {
  if (!s) return 0;
  let h = 0x811c9dc5; // FNV offset basis
  // fg
  if (s.fg !== undefined) {
    if (typeof s.fg === 'number') {
      h = (h ^ (s.fg + 256)) * 0x01000193;
    } else {
      h = (h ^ (s.fg.r + 65536)) * 0x01000193;
      h = (h ^ (s.fg.g + 65792)) * 0x01000193;
      h = (h ^ (s.fg.b + 66048)) * 0x01000193;
    }
  }
  // bg
  if (s.bg !== undefined) {
    if (typeof s.bg === 'number') {
      h = (h ^ (s.bg + 512)) * 0x01000193;
    } else {
      h = (h ^ (s.bg.r + 66304)) * 0x01000193;
      h = (h ^ (s.bg.g + 66560)) * 0x01000193;
      h = (h ^ (s.bg.b + 66816)) * 0x01000193;
    }
  }
  if (s.bold) h = (h ^ 1) * 0x01000193;
  if (s.italic) h = (h ^ 2) * 0x01000193;
  if (s.underline) h = (h ^ 4) * 0x01000193;
  if (s.inverse) h = (h ^ 8) * 0x01000193;
  if (s.dim) h = (h ^ 16) * 0x01000193;
  if (s.url) {
    for (let i = 0; i < s.url.length; i++) {
      h = (h ^ s.url.charCodeAt(i)) * 0x01000193;
    }
  }
  return h | 0;
}

/**
 * Build CSS style from CellStyle
 */
function buildCellStyle(style: CellStyle): CSSProperties {
  const css: CSSProperties = {};

  if (style.fg !== undefined) {
    css.color = cellColorToCss(style.fg);
  }
  if (style.bg !== undefined) {
    css.backgroundColor = cellColorToCss(style.bg);
  }
  if (style.bold) {
    css.fontWeight = 'bold';
  }
  if (style.dim) {
    css.opacity = 0.5;
  }
  if (style.italic) {
    css.fontStyle = 'italic';
  }
  if (style.underline) {
    css.textDecoration = 'underline';
  }
  if (style.inverse) {
    // Swap fg/bg for inverse
    const fg = css.color;
    const bg = css.backgroundColor;
    css.color = bg || 'var(--terminal-bg, #000)';
    css.backgroundColor = fg || 'var(--terminal-fg, #fff)';
  }

  return css;
}

export interface TerminalLineProps {
  line: CellLine;
  lineIndex: number;
  cursorX: number;
  cursorY: number;
  showCursor: boolean;
  inMode: boolean;
  isActive: boolean;
  cursorMode?: CursorMode;
  selectionRange?: { startCol: number; endCol: number } | null;
}

export const TerminalLine = memo(
  function TerminalLine({
    line,
    lineIndex,
    cursorX,
    cursorY,
    showCursor,
    inMode,
    isActive,
    cursorMode = 'block',
    selectionRange,
  }: TerminalLineProps) {
    const isCursorLine = showCursor && lineIndex === cursorY;
    const lineLength = line.length;

    // Render end-of-line cursor if cursor position exceeds line length
    const renderEndOfLineCursor = (): React.ReactNode => {
      if (isCursorLine && cursorX >= lineLength) {
        const padCount = cursorX - lineLength;
        return (
          <>
            {padCount > 0 && <span>{' '.repeat(padCount)}</span>}
            <Cursor
              x={cursorX}
              y={cursorY}
              char=" "
              copyMode={inMode}
              active={isActive}
              mode={cursorMode}
            />
          </>
        );
      }
      return null;
    };

    // Check if a cell index falls within the selection range
    const isCellSelected = (idx: number): boolean => {
      if (!selectionRange) return false;
      return idx >= selectionRange.startCol && idx <= selectionRange.endCol;
    };

    // Memoize URL detection: only re-runs when line reference changes
    // mergeContent() preserves line identity for unchanged lines → cache hits
    const autoUrls = useMemo(() => {
      const text = line.map((c) => c.c).join('');
      return detectUrls(text);
    }, [line]);

    const urlIdx = useCallback(
      (i: number): number => {
        for (let u = 0; u < autoUrls.length; u++) {
          if (i >= autoUrls[u].start && i < autoUrls[u].end) return u;
        }
        return -1;
      },
      [autoUrls],
    );

    // Group consecutive cells with same style for efficiency
    const renderCells = (): React.ReactNode[] => {
      const spans: React.ReactNode[] = [];

      let currentGroup: {
        cells: TerminalCell[];
        style: CellStyle | undefined;
        startIdx: number;
        selected: boolean;
        sk: number;
        autoUrlIdx: number;
        wide: boolean;
      } | null = null;

      const flushGroup = () => {
        if (!currentGroup || currentGroup.cells.length === 0) return;

        const text = currentGroup.cells.map((c) => c.c).join('');
        // Pin the span to an exact number of character cells. `1ch` is the
        // monospace cell advance (width of "0"), so `${n}ch` is independent of
        // the actual glyphs in the run. A glyph whose advance differs from the
        // cell (emoji, spinner symbols, CJK) then paints within / over its fixed
        // box instead of pushing the rest of the line — which is what caused the
        // horizontal jitter when only a few characters changed (e.g. spinners).
        let style: CSSProperties = currentGroup.style ? buildCellStyle(currentGroup.style) : {};
        style.width = `${currentGroup.cells.length}ch`;
        const startIdx = currentGroup.startIdx;
        // OSC 8 explicit URL takes priority over auto-detected
        const oscUrl = currentGroup.style?.url;
        const autoUrl =
          !oscUrl && currentGroup.autoUrlIdx >= 0
            ? autoUrls[currentGroup.autoUrlIdx].url
            : undefined;
        const linkUrl = oscUrl || autoUrl;
        const linkClass = oscUrl ? 'terminal-hyperlink' : autoUrl ? 'terminal-autolink' : undefined;

        // Apply selection highlight — override fg/bg via inline style
        const selectedClass = currentGroup.selected ? 'terminal-selected' : undefined;
        if (currentGroup.selected) {
          style = { ...style, color: 'var(--term-black)', backgroundColor: '#c0c0c0' };
        }

        // Check if cursor is in this group
        if (isCursorLine) {
          const endIdx = startIdx + currentGroup.cells.length;
          if (cursorX >= startIdx && cursorX < endIdx) {
            const localPos = cursorX - startIdx;
            const before = text.slice(0, localPos);
            const cursorChar = text[localPos] || ' ';
            const after = text.slice(localPos + 1);

            const content = (
              <>
                {before}
                <Cursor
                  x={cursorX}
                  y={cursorY}
                  char={cursorChar}
                  copyMode={inMode}
                  active={isActive}
                  mode={cursorMode}
                />
                {after}
              </>
            );

            if (linkUrl) {
              const cls = [linkClass, selectedClass].filter(Boolean).join(' ');
              spans.push(
                <a
                  key={spans.length}
                  href={linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={style}
                  className={cls}
                >
                  {content}
                </a>,
              );
            } else {
              spans.push(
                <span key={spans.length} style={style} className={selectedClass}>
                  {content}
                </span>,
              );
            }
            currentGroup = null;
            return;
          }
        }

        if (linkUrl) {
          const cls = [linkClass, selectedClass].filter(Boolean).join(' ');
          spans.push(
            <a
              key={spans.length}
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={style}
              className={cls}
            >
              {text}
            </a>,
          );
        } else {
          spans.push(
            <span key={spans.length} style={style} className={selectedClass}>
              {text}
            </span>,
          );
        }
        currentGroup = null;
      };

      for (let i = 0; i < line.length; i++) {
        const cell = line[i];
        const cellSK = styleKey(cell.s);
        const selected = isCellSelected(i);
        const cellUrlIdx = cell.s?.url ? -1 : urlIdx(i); // skip auto-detect if OSC 8
        const wide = isWideChar(cell.c);

        if (
          currentGroup &&
          // A wide char is never grouped (with its continuation cell or anything
          // else): its 2-column glyph must own a 1-cell box so it overflows into
          // the blank continuation cell rather than shifting a grouped span.
          !wide &&
          !currentGroup.wide &&
          cellSK === currentGroup.sk &&
          selected === currentGroup.selected &&
          cellUrlIdx === currentGroup.autoUrlIdx
        ) {
          currentGroup.cells.push(cell);
        } else {
          flushGroup();
          currentGroup = {
            cells: [cell],
            style: cell.s,
            startIdx: i,
            selected,
            sk: cellSK,
            autoUrlIdx: cellUrlIdx,
            wide,
          };
        }
      }

      flushGroup();

      // Pad selection highlight beyond line content (e.g., line mode full-width selection)
      if (selectionRange && selectionRange.endCol >= line.length) {
        const padStart = Math.max(selectionRange.startCol, line.length);
        const padLen = selectionRange.endCol - padStart + 1;
        if (padLen > 0) {
          spans.push(
            <span key="sel-pad" className="terminal-selected">
              {' '.repeat(padLen)}
            </span>,
          );
        }
      }

      return spans;
    };

    return (
      <LogProfiler id="TerminalLine">
        <div className="terminal-line">
          {renderCells()}
          {renderEndOfLineCursor()}
        </div>
      </LogProfiler>
    );
  },
  // Custom comparison: only re-render if relevant props changed
  (prevProps, nextProps) => {
    // Always re-render if line content changed
    if (prevProps.line !== nextProps.line) return false;

    // Re-render if selection range changed
    const prevSel = prevProps.selectionRange;
    const nextSel = nextProps.selectionRange;
    if (prevSel !== nextSel) {
      if (!prevSel || !nextSel) return false;
      if (prevSel.startCol !== nextSel.startCol || prevSel.endCol !== nextSel.endCol) return false;
    }

    // Check if cursor was or is on this line
    const prevHasCursor = prevProps.showCursor && prevProps.lineIndex === prevProps.cursorY;
    const nextHasCursor = nextProps.showCursor && nextProps.lineIndex === nextProps.cursorY;

    // If cursor status on this line changed, re-render
    if (prevHasCursor !== nextHasCursor) return false;

    // If cursor is on this line, check if X position changed
    if (nextHasCursor && prevProps.cursorX !== nextProps.cursorX) return false;

    // If cursor is on this line, check if cursor style props changed
    if (nextHasCursor) {
      if (prevProps.inMode !== nextProps.inMode) return false;
      if (prevProps.isActive !== nextProps.isActive) return false;
      if (prevProps.cursorMode !== nextProps.cursorMode) return false;
    }

    // No relevant changes, skip re-render
    return true;
  },
);
