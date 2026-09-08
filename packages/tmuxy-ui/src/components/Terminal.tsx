/**
 * Terminal - Renders structured cell content from Rust backend
 *
 * Uses TerminalLine for efficient per-line memoization.
 * Content is pre-parsed structured cells, not ANSI strings.
 */

import { useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import { Cursor } from './Cursor';
import { cellsToCss } from './terminalShared';
import { cursorShapeToMode } from '../utils/cursorShape';
import { isTauri } from '../tmux/adapters';
import type { CursorMode } from './Cursor';
import type { PaneContent, CellLine, ImagePlacement } from '../tmux/types';

/**
 * Resolve the URL the browser should load for a given image placement.
 *
 * On the web that is the server's `/api/images/...` route. The desktop app
 * serves no HTTP at all, so it hands the same bytes out through its own
 * `tmuxyimg:` scheme (registered in `tmuxy-tauri-app/src/gui.rs`); asking it
 * for `/api/images/...` resolved against the app's own origin and quietly
 * loaded nothing, which is why no image protocol ever drew there.
 *
 * Tests and Storybook stories can override the resolver by setting
 * `window.__tmuxyImageSrc` — useful for serving data:/blob: URLs without
 * standing up a real backend.
 */
function resolveImageSrc(paneId: string, imageId: number): string {
  const numericPaneId = paneId.replace('%', '');
  if (typeof window !== 'undefined') {
    const override = (
      window as unknown as {
        __tmuxyImageSrc?: (paneId: string, imageId: number) => string | undefined;
      }
    ).__tmuxyImageSrc;
    if (override) {
      const resolved = override(paneId, imageId);
      if (resolved) return resolved;
    }
    if (isTauri()) {
      // Windows serves custom schemes over http://<scheme>.localhost; the
      // platforms tmuxy ships a desktop build for use the scheme directly.
      const base = navigator.userAgent.includes('Windows')
        ? 'http://tmuxyimg.localhost'
        : 'tmuxyimg://localhost';
      return `${base}/${numericPaneId}/${imageId}`;
    }
  }
  return `/api/images/${numericPaneId}/${imageId}`;
}

interface TerminalProps {
  content: PaneContent;
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
  /** Image placements on this pane */
  images?: ImagePlacement[];
  /** Pane tmux ID (e.g., "%0") for image URL construction */
  paneId?: string;
  /** Cursor shape from DECSCUSR (0-6) */
  cursorShape?: number;
  /** Whether the cursor is hidden (DECTCEM mode 25 off) */
  cursorHidden?: boolean;
  /**
   * Let the browser select this pane's text.
   *
   * False for a pane whose application is tracking the mouse: there a drag is
   * the application's, forwarded as SGR, and a selection would fight it.
   */
  selectable?: boolean;
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
  let sy = selectionStart.y,
    sx = selectionStart.x;
  let ey = copyCursorY,
    ex = copyCursorX;
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
  images,
  paneId,
  cursorShape = 0,
  cursorHidden = false,
  selectable = false,
}) => {
  // Use copy mode cursor position when in copy mode
  const effectiveCursorX = inMode ? copyCursorX : cursorX;
  const effectiveCursorY = inMode ? copyCursorY : cursorY;
  // Only the pane holding the keyboard draws a cursor. It honours the
  // application's DECTCEM-off except in copy mode, where the cursor is the
  // selection point and must stay visible. An unfocused pane draws nothing even
  // when tmux reports a mode on it: the dock lives in another window and can
  // carry a stale or out-of-band mode flag, and a hollow box at the copy
  // cursor's resting (0,0) read as a ghost cursor in its first row.
  const showCursor = isActive && (!cursorHidden || inMode);

  // Derive cursor mode from DECSCUSR shape (blink is intentionally dropped —
  // tmuxy doesn't render a blinking cursor regardless of what the running
  // application requests via DECSCUSR).
  const cursorStyle = useMemo(() => cursorShapeToMode(cursorShape), [cursorShape]);
  const cursorMode = inMode ? ('block' as CursorMode) : cursorStyle.mode;

  // Resolve selection start: mouse drag (optimistic) takes priority, then backend (authoritative)
  const effectiveSelectionStart = useMemo(() => {
    if (selectionStart) return selectionStart;
    if (selectionPresent) return { x: selectionStartX, y: selectionStartY };
    return null;
  }, [selectionStart, selectionPresent, selectionStartX, selectionStartY]);

  // Compute selection ranges for each line
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

  // Pad content to fill height. When stale content is TALLER than the pane —
  // an optimistic shrink (split/kill/resize) applied before the re-captured
  // viewport arrived — keep the rows ending at the last row that actually has
  // content: tmux anchors a shrinking pane to the prompt/cursor, so the tail is
  // what the server keeps visible, and clipping from the top would hide the
  // pane's most recent lines for the whole round-trip.
  //
  // Anchoring on the last non-blank row rather than on the buffer's end matters
  // because a stale buffer is usually mostly blank: a shell with a few lines of
  // output in a formerly taller pane leaves the tail empty, so keeping the
  // literal bottom rows renders the pane completely BLANK until the re-capture
  // lands. That is the common case right after a split.
  const staleClipOffset = useMemo(() => {
    const overflow = content.length - height;
    if (overflow <= 0) return 0;
    let lastNonBlank = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.some((cell) => cell.c && cell.c !== ' ')) {
        lastNonBlank = i;
        break;
      }
    }
    if (lastNonBlank < 0) return overflow;
    return Math.min(overflow, Math.max(0, lastNonBlank - height + 1));
  }, [content, height]);
  const lines = useMemo(() => {
    const result: CellLine[] = content.slice(staleClipOffset, staleClipOffset + height);
    while (result.length < height) {
      result.push(EMPTY_LINE);
    }
    return result;
  }, [content, height, staleClipOffset]);

  // Cursor row within the rendered viewport, after stale-content clipping.
  const cursorRow = effectiveCursorY - staleClipOffset;
  const cursorVisible = showCursor && cursorRow >= 0 && cursorRow < lines.length;

  // The character the block cursor paints over. Indexed by CELL, which is what
  // effectiveCursorX is — never by position in the line's joined text, whose
  // UTF-16 offsets diverge from cell offsets on any cell holding more than one
  // code unit (variation selectors, combining marks).
  const cursorChar = useMemo(() => {
    if (!cursorVisible) return ' ';
    return lines[cursorRow]?.[effectiveCursorX]?.c || ' ';
  }, [cursorVisible, lines, cursorRow, effectiveCursorX]);

  return (
    <div className="terminal-container" data-testid="terminal" role="log" aria-live="off">
      <pre
        className={`terminal-content ${selectable ? 'terminal-selectable' : ''}`}
        aria-hidden="true"
      >
        {lines.map((line, lineIndex) => (
          <TerminalLine key={lineIndex} line={line} selectionRange={getSelectionRange(lineIndex)} />
        ))}
      </pre>
      {cursorVisible && (
        <Cursor
          x={effectiveCursorX}
          y={cursorRow}
          char={cursorChar}
          mode={cursorMode}
          copyMode={inMode}
        />
      )}
      {images && images.length > 0 && paneId && (
        <div className="terminal-images">
          {images.map((img) => (
            <img
              // Keyed by WHERE it sits, not by which frame it is. A preview
              // repaints at the same anchor once a second with a fresh id; on
              // an id key React threw the element away and built a new one,
              // which paints nothing until its bytes arrive — the picture
              // blinked out between frames. Reusing the element lets the
              // browser hold the old frame on screen until the new one has
              // decoded, so the swap is seamless.
              key={`${img.row}:${img.col}`}
              className="terminal-image"
              src={resolveImageSrc(paneId, img.id)}
              alt=""
              data-protocol={img.protocol}
              data-image-id={img.id}
              // Same grid units the rows and the cursor use: `--cell-w` (the
              // snapped cell width the style-group spans are pinned to) and
              // --line-height-terminal (the row height).
              style={{
                position: 'absolute',
                top: `calc(${img.row} * var(--line-height-terminal))`,
                left: cellsToCss(img.col),
                width: cellsToCss(img.widthCells),
                height: `calc(${img.heightCells} * var(--line-height-terminal))`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
