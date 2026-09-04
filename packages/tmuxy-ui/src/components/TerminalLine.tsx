/**
 * TerminalLine - Memoized terminal line component
 *
 * Renders pre-parsed cell data from Rust backend.
 * Only re-renders when line content or the selection range changes.
 *
 * The cursor is NOT rendered here: Terminal draws it as a grid-positioned
 * overlay. Splicing it into this line's text tied its position to the natural
 * advance of the preceding glyphs and to UTF-16 offsets within the cell run,
 * which drifted off the cell grid. Keeping it out also means a moving cursor
 * no longer re-renders lines.
 */

import { memo, useMemo, useCallback, CSSProperties } from 'react';
import { LogProfiler } from '../utils/renderLog';
import type { CellLine, TerminalCell, CellStyle } from '../tmux/types';
import { cellColorToCss, cellsToCss, isWideChar } from './terminalShared';
import { rowEdgeBackground } from './terminalRendering';
import { glyphFit } from '../utils/glyphFit';
import { isBlockGlyph, blockGlyphStyle } from './blockGlyphs';
import { detectUrls } from '../utils/urlDetect';
import { openExternalUrl } from '../utils/openUrl';

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
  selectionRange?: { startCol: number; endCol: number } | null;
}

export const TerminalLine = memo(
  function TerminalLine({ line, selectionRange }: TerminalLineProps) {
    // Check if a cell index falls within the selection range
    const isCellSelected = (idx: number): boolean => {
      if (!selectionRange) return false;
      return idx >= selectionRange.startCol && idx <= selectionRange.endCol;
    };

    // Memoize URL detection: only re-runs when line reference changes
    // mergeContent() preserves line identity for unchanged lines → cache hits
    //
    // detectUrls reports UTF-16 offsets into the joined text, but callers ask
    // about CELL indices. A cell can hold more than one code unit (variation
    // selectors, combining marks), so keep the per-cell offset map to translate
    // rather than comparing a cell index against a string offset.
    const { autoUrls, cellOffsets } = useMemo(() => {
      const offsets = new Array<number>(line.length);
      let text = '';
      for (let i = 0; i < line.length; i++) {
        offsets[i] = text.length;
        text += line[i].c;
      }
      return { autoUrls: detectUrls(text), cellOffsets: offsets };
    }, [line]);

    const urlIdx = useCallback(
      (i: number): number => {
        const off = cellOffsets[i];
        for (let u = 0; u < autoUrls.length; u++) {
          if (off >= autoUrls[u].start && off < autoUrls[u].end) return u;
        }
        return -1;
      },
      [autoUrls, cellOffsets],
    );

    // Group consecutive cells with same style for efficiency
    const renderCells = (): React.ReactNode[] => {
      const spans: React.ReactNode[] = [];

      let currentGroup: {
        cells: TerminalCell[];
        style: CellStyle | undefined;
        selected: boolean;
        sk: number;
        autoUrlIdx: number;
        wide: boolean;
        blockCh: string | null;
        /** `scale()` that fits a fat one-column glyph into its cell (utils/glyphFit). */
        fit: number | null;
      } | null = null;

      const flushGroup = () => {
        if (!currentGroup || currentGroup.cells.length === 0) return;

        const text = currentGroup.cells.map((c) => c.c).join('');
        // Pin the span to an exact number of cells (`--cell-w`, the snapped
        // grid width — see utils/cellMetrics.ts), independent of the actual
        // glyphs in the run. A glyph whose advance differs from the cell
        // (emoji, spinner symbols, CJK) then paints within / over its fixed box
        // instead of pushing the rest of the line — which is what caused the
        // horizontal jitter when only a few characters changed (e.g. spinners).
        let style: CSSProperties = currentGroup.style ? buildCellStyle(currentGroup.style) : {};
        style.width = cellsToCss(currentGroup.cells.length);
        const blockCh = currentGroup.blockCh;
        // OSC 8 explicit URL takes priority over auto-detected
        const oscUrl = currentGroup.style?.url;
        const autoUrl =
          !oscUrl && currentGroup.autoUrlIdx >= 0
            ? autoUrls[currentGroup.autoUrlIdx].url
            : undefined;
        const linkUrl = oscUrl || autoUrl;
        const linkClass = oscUrl ? 'terminal-hyperlink' : autoUrl ? 'terminal-autolink' : undefined;

        // A one-column glyph wider than its cell shrinks into it instead of
        // painting over the run that follows (see utils/glyphFit.ts). The
        // scale goes on an inner element so the span keeps its 1-cell box.
        const fitClass = currentGroup.fit !== null ? 'terminal-fit' : undefined;
        const content =
          currentGroup.fit !== null ? (
            <span
              className="terminal-fit-glyph"
              style={{ '--glyph-fit': String(currentGroup.fit) } as CSSProperties}
            >
              {text}
            </span>
          ) : (
            text
          );

        // Apply selection highlight — override fg/bg via inline style
        const selectedClass =
          [currentGroup.selected ? 'terminal-selected' : undefined, fitClass]
            .filter(Boolean)
            .join(' ') || undefined;
        if (currentGroup.selected) {
          style = { ...style, color: 'var(--term-black)', backgroundColor: '#c0c0c0' };
        }

        // Block Elements are drawn as CSS rectangles rather than font glyphs so
        // they fill the cell exactly and stacked rows tile seamlessly. The
        // character stays as (transparent) text, keeping copy/paste intact.
        if (blockCh) {
          const painted = blockGlyphStyle(
            blockCh,
            (style.color as string) ?? 'var(--terminal-fg, #fff)',
          );
          if (painted) {
            style = { ...style, ...painted, color: 'transparent' };
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
              draggable={false}
              style={style}
              className={cls}
              // Opened through openExternalUrl rather than the anchor's own
              // navigation: the desktop webview denies new windows, so the
              // default did nothing there. preventDefault keeps the browser
              // build from opening it twice.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openExternalUrl(linkUrl);
              }}
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
      };

      for (let i = 0; i < line.length; i++) {
        const cell = line[i];
        const cellSK = styleKey(cell.s);
        const selected = isCellSelected(i);
        const cellUrlIdx = cell.s?.url ? -1 : urlIdx(i); // skip auto-detect if OSC 8
        const wide = isWideChar(cell.c);
        const blockCh = isBlockGlyph(cell.c) ? cell.c : null;
        const fit = !wide && !blockCh ? glyphFit(cell.c) : null;

        if (
          currentGroup &&
          // A wide char is never grouped (with its continuation cell or anything
          // else): its 2-column glyph must own a 1-cell box so it overflows into
          // the blank continuation cell rather than shifting a grouped span.
          !wide &&
          !currentGroup.wide &&
          // A fat glyph is shrunk on its own; it never shares a box.
          fit === null &&
          currentGroup.fit === null &&
          // A geometric block run is one repeated glyph: a different block
          // char (or ordinary text) needs its own box to paint into.
          blockCh === currentGroup.blockCh &&
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
            selected,
            sk: cellSK,
            autoUrlIdx: cellUrlIdx,
            wide,
            blockCh,
            fit,
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

    // Row edges reach the pane border in the first / last cell's colours
    // (`.terminal-line::before` / `::after`).
    const edgeLeft = rowEdgeBackground(line[0]?.s);
    const edgeRight = rowEdgeBackground(line[line.length - 1]?.s);
    const edgeStyle =
      edgeLeft !== undefined || edgeRight !== undefined
        ? ({
            ...(edgeLeft !== undefined && { '--row-edge-left': edgeLeft }),
            ...(edgeRight !== undefined && { '--row-edge-right': edgeRight }),
          } as CSSProperties)
        : undefined;

    return (
      <LogProfiler id="TerminalLine">
        <div className="terminal-line" style={edgeStyle}>
          {renderCells()}
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

    // No relevant changes, skip re-render
    return true;
  },
);
