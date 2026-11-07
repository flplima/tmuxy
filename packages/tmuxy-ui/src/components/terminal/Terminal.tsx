import { useMemo } from 'react';
import { TerminalLine } from './TerminalLine';
import { Cursor, type CursorMode } from './Cursor';
import { resolveImageSrc } from './terminalShared';
import { cellsToCss } from '../../infra/dom/cellMetrics';
import { cursorShapeToMode } from './cursorShape';
import { isWrappedRow, selectionColumns } from '../../domain/copyMode';
import { detectUrlsAcrossRows } from './urlDetect';
import { setLinkHot } from './linkHover';
import type { ImagePlacement } from '../../domain/client';
import type { PaneContent, CellLine } from '../../domain/wireCells';
import type { PaneId } from '../../domain/ids';
import { TERMINAL_CONTENT, TERMINAL_SELECTABLE } from '../../infra/dom/terminalDom';

interface TerminalProps {
  content: PaneContent;
  cursorX?: number;
  cursorY?: number;
  isActive?: boolean;
  width?: number;
  height?: number;
  inMode?: boolean;
  copyCursorX?: number;
  copyCursorY?: number;
  selectionPresent?: boolean;
  /** A mouse drag's start, shown before tmux reports the selection. */
  selectionStart?: { x: number; y: number } | null;
  selectionStartX?: number;
  /** Visible-relative row. */
  selectionStartY?: number;
  images?: ImagePlacement[];
  paneId?: PaneId;
  /** DECSCUSR shape (0-6). */
  cursorShape?: number;
  /** DECTCEM (mode 25) off. */
  cursorHidden?: boolean;
  /**
   * Let the browser select this pane's text. False for a pane whose
   * application tracks the mouse: the drag is the application's, forwarded as SGR.
   */
  selectable?: boolean;
  /** False for a thumbnail: link text is drawn, but nothing is a link. */
  links?: boolean;
}

const EMPTY_LINE: CellLine = [];

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
  links = true,
}) => {
  const effectiveCursorX = inMode ? copyCursorX : cursorX;
  const effectiveCursorY = inMode ? copyCursorY : cursorY;
  // DECTCEM-off is honoured except in copy mode, where the cursor is the
  // selection point. An unfocused pane draws none even when tmux reports a
  // mode on it: the dock lives in another window and can carry a stale mode
  // flag, which drew a ghost cursor at the copy cursor's resting (0,0).
  const showCursor = isActive && (!cursorHidden || inMode);

  // Whether a blink is drawn at all is `@tmuxy-cursor-blink` (a class on the
  // app container); a steady DECSCUSR shape (2/4/6) overrides it, and the
  // copy-mode cursor never blinks.
  const cursorStyle = useMemo(() => cursorShapeToMode(cursorShape), [cursorShape]);
  const cursorMode = inMode ? ('block' as CursorMode) : cursorStyle.mode;
  const cursorBlinks = !inMode && cursorStyle.blink;

  const effectiveSelectionStart = useMemo(() => {
    if (selectionStart) return selectionStart;
    if (selectionPresent) return { x: selectionStartX, y: selectionStartY };
    return null;
  }, [selectionStart, selectionPresent, selectionStartX, selectionStartY]);

  const getSelectionRange = useMemo(
    () =>
      selectionPresent && effectiveSelectionStart
        ? selectionColumns(
            { row: effectiveSelectionStart.y, col: effectiveSelectionStart.x },
            { row: copyCursorY, col: copyCursorX },
            width,
          )
        : () => null,
    [selectionPresent, effectiveSelectionStart, copyCursorX, copyCursorY, width],
  );

  // Content TALLER than the pane is an optimistic shrink (split/kill/resize)
  // ahead of the re-capture. tmux anchors a shrinking pane to the prompt, so
  // keep the rows ending at the last non-blank one: not the top (that hides
  // the newest lines), and not the buffer's end, which after a split is
  // usually blank.
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

  const rowUrls = useMemo(() => detectUrlsAcrossRows(lines, width), [lines, width]);

  const cursorRow = effectiveCursorY - staleClipOffset;
  const cursorVisible = showCursor && cursorRow >= 0 && cursorRow < lines.length;

  // Indexed by cell, never by the joined text: UTF-16 offsets diverge from
  // cells on any cell holding several code units (variation selectors,
  // combining marks).
  const cursorChar = useMemo(() => {
    if (!cursorVisible) return ' ';
    return lines[cursorRow]?.[effectiveCursorX]?.c || ' ';
  }, [cursorVisible, lines, cursorRow, effectiveCursorX]);

  const visibleImages = useMemo(
    () => images?.filter((img) => img.row + img.heightCells > 0 && img.row < height),
    [images, height],
  );

  return (
    <div className="terminal-container" data-testid="terminal" role="log" aria-live="off">
      <pre
        className={`${TERMINAL_CONTENT} ${selectable ? TERMINAL_SELECTABLE : ''}`}
        aria-hidden="true"
        onMouseOver={(e) => setLinkHot(e.target, true)}
        onMouseOut={(e) => setLinkHot(e.target, false)}
      >
        {lines.map((line, lineIndex) => (
          <TerminalLine
            key={lineIndex}
            line={line}
            selectionRange={getSelectionRange(lineIndex)}
            wrapped={isWrappedRow(line, width)}
            autoUrls={rowUrls[lineIndex]}
            links={links}
          />
        ))}
      </pre>
      {cursorVisible && (
        <Cursor
          x={effectiveCursorX}
          y={cursorRow}
          char={cursorChar}
          mode={cursorMode}
          copyMode={inMode}
          blink={cursorBlinks}
        />
      )}
      {visibleImages && visibleImages.length > 0 && paneId && (
        <div className="terminal-images">
          {visibleImages.map((img) => (
            <img
              // Keyed by anchor, not id: a preview repaints at the same anchor
              // with a fresh id, and a reused <img> lets the browser hold the
              // old frame until the new one has decoded; a new element paints
              // nothing until its bytes arrive.
              key={`${img.row}:${img.col}`}
              className="terminal-image"
              src={resolveImageSrc(paneId, img.id)}
              alt=""
              data-protocol={img.protocol}
              data-image-id={img.id}
              onError={(event) => {
                console.warn('tmuxy failed to load terminal image', {
                  paneId,
                  imageId: img.id,
                  src: event.currentTarget.currentSrc || event.currentTarget.src,
                  protocol: img.protocol,
                });
              }}
              style={{
                position: 'absolute',
                top: `calc(${img.row} * var(--line-height-terminal))`,
                left: cellsToCss(img.col),
                width: cellsToCss(img.widthCells),
                height: `calc(${img.heightCells} * var(--line-height-terminal))`,
                // iTerm2's `preserveAspectRatio=0`: the picture fills its cells,
                // which a program can map clicks through.
                objectFit: img.stretch ? 'fill' : undefined,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
