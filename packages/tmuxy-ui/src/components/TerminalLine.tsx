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
import type { CellLine, TerminalCell, CellColor, CellStyle } from '../tmux/types';
import { detectUrls } from '../utils/urlDetect';

/**
 * Standard 16 terminal colors mapped to CSS theme variables.
 * These match the --term-* variables defined in each theme CSS file.
 */
const STANDARD_16_VARS = [
  'var(--term-black)',
  'var(--term-red)',
  'var(--term-green)',
  'var(--term-yellow)',
  'var(--term-blue)',
  'var(--term-magenta)',
  'var(--term-cyan)',
  'var(--term-white)',
  'var(--term-bright-black)',
  'var(--term-bright-red)',
  'var(--term-bright-green)',
  'var(--term-bright-yellow)',
  'var(--term-bright-blue)',
  'var(--term-bright-magenta)',
  'var(--term-bright-cyan)',
  'var(--term-bright-white)',
];

/**
 * Convert CellColor to CSS color string
 */
function cellColorToCss(color: CellColor): string {
  if (typeof color === 'number') {
    // Standard 16 colors use theme CSS variables
    if (color < 16) return STANDARD_16_VARS[color];
    // Extended 256 colors use computed hex
    return getAnsi256Color(color);
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
    '#000000',
    '#cd0000',
    '#00cd00',
    '#cdcd00',
    '#0000ee',
    '#cd00cd',
    '#00cdcd',
    '#e5e5e5',
    '#7f7f7f',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#5c5cff',
    '#ff00ff',
    '#00ffff',
    '#ffffff',
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
 * Whether a cell's character is double-width (occupies two terminal columns):
 * CJK ideographs, kana, Hangul, fullwidth forms, and emoji.
 *
 * The backend (vt100) emits such a character as TWO data cells — the character
 * plus a continuation cell rendered as a space — so the column grid already
 * accounts for both columns. We use this only to keep a wide character in its
 * OWN span: its glyph then advances ~2 cells and overflows into the (blank)
 * continuation cell instead of pushing the rest of a grouped span off the grid.
 * Over-detection is harmless (a narrow char in its own 1-cell span renders the
 * same), so the ranges err toward the standard East Asian "Wide"/"Fullwidth"
 * and emoji blocks.
 */
function isWideChar(s: string): boolean {
  if (!s) return false;
  const cp = s.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B and beyond
  );
}

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
