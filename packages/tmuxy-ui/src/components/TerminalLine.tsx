/**
 * TerminalLine - Memoized terminal line component
 *
 * Renders pre-parsed cell data from Rust backend.
 * Only re-renders when:
 * - Line content changes
 * - Cursor moves to/from this line
 * - Cursor X position changes (when cursor is on this line)
 */

import { memo, CSSProperties } from 'react';
import { Cursor } from './Cursor';
import type { CellLine, TerminalCell, CellColor, CellStyle } from '../tmux/types';

/**
 * Convert CellColor to CSS color string
 */
function cellColorToCss(color: CellColor): string {
  if (typeof color === 'number') {
    // Indexed color (0-255)
    return `var(--ansi-${color}, ${getAnsi256Color(color)})`;
  } else {
    // RGB color
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }
}

/**
 * Get ANSI 256 color as hex
 */
function getAnsi256Color(index: number): string {
  // Standard 16 colors
  const standard16 = [
    '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
    '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  if (index < 16) return standard16[index];

  // 216 color cube (6x6x6)
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // 24 grayscale
  const gray = 8 + (index - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
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
  selectionRange?: { startCol: number; endCol: number } | null;
  /** Terminal width in columns (needed to pad selection highlight beyond line content) */
  width: number;
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
    selectionRange,
    width: _width,
  }: TerminalLineProps) {
    const isCursorLine = showCursor && lineIndex === cursorY;
    const lineLength = line.length;

    // Render end-of-line cursor if cursor position exceeds line length
    const renderEndOfLineCursor = (): React.ReactNode => {
      if (isCursorLine && cursorX >= lineLength) {
        const padding = ' '.repeat(cursorX - lineLength);
        return (
          <>
            {padding}
            <Cursor x={cursorX} y={cursorY} char=" " copyMode={inMode} active={isActive} mode="block" />
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

    // Group consecutive cells with same style for efficiency
    const renderCells = (): React.ReactNode[] => {
      const spans: React.ReactNode[] = [];
      let currentGroup: { cells: TerminalCell[]; style: CellStyle | undefined; startIdx: number; selected: boolean } | null = null;

      const flushGroup = () => {
        if (!currentGroup || currentGroup.cells.length === 0) return;

        const text = currentGroup.cells.map((c) => c.c).join('');
        let style = currentGroup.style ? buildCellStyle(currentGroup.style) : undefined;
        const startIdx = currentGroup.startIdx;
        const url = currentGroup.style?.url;

        // Apply selection highlight via CSS overlay
        const selectedClass = currentGroup.selected ? 'terminal-selected' : undefined;

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
                <Cursor x={cursorX} y={cursorY} char={cursorChar} copyMode={inMode} active={isActive} mode="block" />
                {after}
              </>
            );

            // Wrap in anchor if URL present
            if (url) {
              spans.push(
                <a
                  key={spans.length}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={style}
                  className={selectedClass ? `terminal-hyperlink ${selectedClass}` : 'terminal-hyperlink'}
                >
                  {content}
                </a>
              );
            } else {
              spans.push(
                <span key={spans.length} style={style} className={selectedClass}>
                  {content}
                </span>
              );
            }
            currentGroup = null;
            return;
          }
        }

        // Wrap in anchor if URL present
        if (url) {
          spans.push(
            <a
              key={spans.length}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={style}
              className={selectedClass ? `terminal-hyperlink ${selectedClass}` : 'terminal-hyperlink'}
            >
              {text}
            </a>
          );
        } else {
          spans.push(
            <span key={spans.length} style={style} className={selectedClass}>
              {text}
            </span>
          );
        }
        currentGroup = null;
      };

      for (let i = 0; i < line.length; i++) {
        const cell = line[i];
        const cellStyleKey = cell.s ? JSON.stringify(cell.s) : '';
        const selected = isCellSelected(i);

        if (!currentGroup) {
          currentGroup = { cells: [cell], style: cell.s, startIdx: i, selected };
        } else {
          const currentStyleKey = currentGroup.style ? JSON.stringify(currentGroup.style) : '';
          if (cellStyleKey === currentStyleKey && selected === currentGroup.selected) {
            currentGroup.cells.push(cell);
          } else {
            flushGroup();
            currentGroup = { cells: [cell], style: cell.s, startIdx: i, selected };
          }
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
            </span>
          );
        }
      }

      return spans;
    };

    return (
      <div className="terminal-line">
        {renderCells()}
        {renderEndOfLineCursor()}
      </div>
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
    }

    // No relevant changes, skip re-render
    return true;
  }
);
