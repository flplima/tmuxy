/**
 * Terminal - Renders structured cell content from Rust backend
 *
 * Uses TerminalLine for efficient per-line memoization.
 * Content is pre-parsed structured cells, not ANSI strings.
 */

import { useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import { cursorShapeToMode } from '../utils/cursorShape';
import type { CursorMode } from './Cursor';
import type { PaneContent, CellLine, ImagePlacement } from '../tmux/types';

/**
 * Resolve the URL the browser should load for a given image placement.
 * In production this points at the server's `/api/images/...` route. Tests
 * and Storybook stories can override the resolver by setting
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
}) => {
  // Use copy mode cursor position when in copy mode
  const effectiveCursorX = inMode ? copyCursorX : cursorX;
  const effectiveCursorY = inMode ? copyCursorY : cursorY;
  // Hide cursor when application requests it (DECTCEM off), but always show in copy mode
  const showCursor = (isActive && !cursorHidden) || inMode;

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
  // viewport arrived — keep the BOTTOM rows: tmux anchors a shrinking pane to
  // the prompt/cursor, so the tail is what the server keeps visible. Clipping
  // the top instead of the bottom hides the pane's most recent lines for the
  // whole round-trip.
  const staleClipOffset = Math.max(0, content.length - height);
  const lines = useMemo(() => {
    if (staleClipOffset > 0) return content.slice(staleClipOffset);
    const result: CellLine[] = [...content];
    while (result.length < height) {
      result.push(EMPTY_LINE);
    }
    return result;
  }, [content, height, staleClipOffset]);

  return (
    <div className="terminal-container" data-testid="terminal" role="log" aria-live="off">
      <pre className="terminal-content" aria-hidden="true">
        {lines.map((line, lineIndex) => (
          <TerminalLine
            key={lineIndex}
            line={line}
            lineIndex={lineIndex}
            cursorX={effectiveCursorX}
            cursorY={effectiveCursorY - staleClipOffset}
            showCursor={showCursor}
            inMode={inMode}
            isActive={isActive}
            cursorMode={cursorMode}
            selectionRange={getSelectionRange(lineIndex)}
          />
        ))}
      </pre>
      {images && images.length > 0 && paneId && (
        <div className="terminal-images">
          {images.map((img) => (
            <img
              key={img.id}
              className="terminal-image"
              src={resolveImageSrc(paneId, img.id)}
              alt=""
              data-protocol={img.protocol}
              data-image-id={img.id}
              style={{
                position: 'absolute',
                top: `calc(${img.row} * var(--cell-height))`,
                left: `calc(${img.col} * var(--cell-width))`,
                width: `calc(${img.widthCells} * var(--cell-width))`,
                height: `calc(${img.heightCells} * var(--cell-height))`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
