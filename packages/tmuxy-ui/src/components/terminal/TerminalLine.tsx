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
   * Soft-wrapped into the next row (`isWrappedRow`). Published as
   * `data-wrapped`: the browser selection's copy path reads the DOM, and joins
   * wrapped rows rather than breaking a long command at the pane's width.
   */
  wrapped?: boolean;
  /** Detected over the logical line by the parent; absent, the row detects its own. */
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
    // Glyph widths measured at first paint can be the fallback font's; the
    // cache says when the webfont changed its answer.
    useSyncExternalStore(subscribeGlyphFit, getGlyphFitVersion, getGlyphFitVersion);

    const urlIndex = useMemo(() => rowUrlIndex(line, rowUrls), [line, rowUrls]);

    const renderCells = (): React.ReactNode[] => {
      const spans: React.ReactNode[] = cellRuns(line, selectionRange, urlIndex).map((run, key) => {
        const { className, style } = runPaint(run, links);
        // Scaled on an inner element, so the span keeps its 1-cell box.
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
            // Not the anchor's own navigation: the desktop webview denies new
            // windows, and a plugin's link handler gets its turn first (Shift
            // skips it).
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
  (prevProps, nextProps) => {
    if (prevProps.line !== nextProps.line) return false;
    if (prevProps.wrapped !== nextProps.wrapped) return false;
    if (prevProps.links !== nextProps.links) return false;

    // A neighbour's change can alter this row's links.
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

    const prevSel = prevProps.selectionRange;
    const nextSel = nextProps.selectionRange;
    if (prevSel !== nextSel) {
      if (!prevSel || !nextSel) return false;
      if (prevSel.startCol !== nextSel.startCol || prevSel.endCol !== nextSel.endCol) return false;
    }

    return true;
  },
);
