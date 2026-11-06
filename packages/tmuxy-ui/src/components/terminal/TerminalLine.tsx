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

import { memo, useMemo, useSyncExternalStore, CSSProperties } from 'react';
import { LogProfiler } from '../renderLog';
import type { CellLine } from '../../domain/wireCells';
import { subscribeGlyphFit, getGlyphFitVersion } from './glyphFit';
import { sameUrls, type DetectedUrl } from './urlDetect';
import { cellRuns, rowUrlIndex, runPaint, selectionPad, type SelectionCols } from './cellPaint';
import { openLinkFrom, safeHref } from '../../infra/openUrl';
import { TERMINAL_LINE } from '../../infra/dom/terminalDom';

export interface TerminalLineProps {
  line: CellLine;
  selectionRange?: SelectionCols | null;
  /**
   * Whether this row is a soft-wrapped continuation into the next one — i.e.
   * there is no logical line break between them (see `isWrappedRow`).
   *
   * Published as `data-wrapped` because the copy path reads the DOM, not this
   * component's props: a native browser selection spans rows as elements, and
   * joining the ones that only wrapped is the difference between copying a long
   * command as one line and copying it broken at the pane's width.
   */
  wrapped?: boolean;
  /**
   * The row's auto-detected URLs when the parent detected them over the
   * logical line (`detectUrlsAcrossRows`), so a URL that wraps links every
   * row it covers to the whole address. Absent, the row detects its own.
   */
  autoUrls?: DetectedUrl[];
  /** False draws a link's text as plain text: a picture of a pane, not the pane. */
  links?: boolean;
}

export const TerminalLine = memo(
  function TerminalLine({
    line,
    selectionRange,
    wrapped,
    autoUrls: rowUrls,
    links = true,
  }: TerminalLineProps) {
    // How wide a symbol really is can only be measured against the font the
    // page ends up using, and at first paint that is not yet the one it will
    // settle on. The measurement cache says when it has changed its mind; a
    // line already drawn has to be drawn again to act on it.
    useSyncExternalStore(subscribeGlyphFit, getGlyphFitVersion, getGlyphFitVersion);

    // Re-runs only when the line reference changes: mergeContent() keeps
    // the identity of unchanged lines.
    const urlIndex = useMemo(() => rowUrlIndex(line, rowUrls), [line, rowUrls]);

    const renderCells = (): React.ReactNode[] => {
      const spans: React.ReactNode[] = cellRuns(line, selectionRange, urlIndex).map((run, key) => {
        const { className, style } = runPaint(run, links);
        // A one-column glyph wider than its cell shrinks into it on an inner
        // element, so the span keeps its 1-cell box (glyphFit.ts).
        const glyph =
          run.fit !== null ? (
            <span
              className="terminal-fit-glyph"
              style={{ '--glyph-fit': String(run.fit) } as CSSProperties}
            >
              {run.text}
            </span>
          ) : (
            run.text
          );
        const content = run.style?.size ? (
          <span className="terminal-scaled-text" data-size={run.style.size}>
            {glyph}
          </span>
        ) : (
          glyph
        );
        if (!run.link || !links) {
          return (
            <span key={key} style={style} className={className}>
              {content}
            </span>
          );
        }
        const { url } = run.link;
        const href = safeHref(url);
        return (
          <a
            key={key}
            href={href}
            title={href}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            // A pointer target only: the pane's text is hidden from
            // assistive technology, and Tab in a pane belongs to tmux.
            tabIndex={-1}
            style={style}
            className={className}
            // Opened through openLinkFrom rather than the anchor's own
            // navigation: the desktop webview denies new windows, so the
            // default did nothing there, and a plugin's link handler gets
            // its turn first (Shift skips it). preventDefault keeps the
            // browser build from opening it twice.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openLinkFrom(e.currentTarget, url, e.shiftKey);
            }}
          >
            {content}
          </a>
        );
      });

      // Pad selection highlight beyond line content (e.g., line mode full-width selection)
      const pad = selectionPad(line, selectionRange);
      if (pad > 0) {
        spans.push(
          <span key="sel-pad" className="terminal-selected">
            {' '.repeat(pad)}
          </span>,
        );
      }
      return spans;
    };

    return (
      <LogProfiler id="TerminalLine">
        <div className={TERMINAL_LINE} data-wrapped={wrapped ? 'true' : undefined}>
          {renderCells()}
        </div>
      </LogProfiler>
    );
  },
  // Custom comparison: only re-render if relevant props changed
  (prevProps, nextProps) => {
    // Always re-render if line content changed
    if (prevProps.line !== nextProps.line) return false;

    // `data-wrapped` is what the copy path reads, so a row that stops (or
    // starts) wrapping has to redraw even when its cells are untouched.
    if (prevProps.wrapped !== nextProps.wrapped) return false;
    if (prevProps.links !== nextProps.links) return false;

    // A neighbour's change can alter this row's links (the URL it continues).
    if (
      prevProps.autoUrls !== nextProps.autoUrls &&
      !(
        prevProps.autoUrls &&
        nextProps.autoUrls &&
        sameUrls(prevProps.autoUrls, nextProps.autoUrls)
      )
    ) {
      return false;
    }

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
