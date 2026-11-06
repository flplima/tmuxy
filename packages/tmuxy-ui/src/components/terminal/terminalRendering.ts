/**
 * The scroll view's rows (ScrollbackTerminal), written straight into the DOM:
 * its rows are mounted and repainted one by one as the window moves, which
 * React would do slower. What each run of cells looks like is `cellPaint`'s,
 * shared with the live grid's `TerminalLine`; this only builds the nodes.
 */

import type { CellLine } from '../../domain/wireCells';
import { cellColorToCss, sameCellColor } from './terminalShared';
import type { DetectedUrl } from './urlDetect';
import { safeHref } from '../../infra/openUrl';
import {
  cellRuns,
  rowUrlIndex,
  runPaint,
  selectionPad,
  type CellRun,
  type SelectionCols,
} from './cellPaint';

/**
 * Detect the dominant background color for a line.
 * If more than half the cells share the same non-default bg, return it as CSS.
 * This covers neovim/lazyvim theme backgrounds that differ from the terminal default.
 */
function detectLineBg(line: CellLine): string | null {
  if (line.length === 0) return null;

  // Fast path: check the first cell — most theme backgrounds are uniform
  const firstBg = line[0].s?.bg;
  if (firstBg === undefined) return null;

  // Verify at least half the line shares this bg (avoid false positives from
  // syntax highlighting putting bg on just a few cells)
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (sameCellColor(line[i].s?.bg, firstBg)) count++;
  }
  if (count > line.length / 2) {
    return cellColorToCss(firstBg);
  }
  return null;
}

/** One run's node: a link or a span, painted as `runPaint` says. */
function runNode(run: CellRun): HTMLElement {
  let node: HTMLElement;
  if (run.link) {
    const a = document.createElement('a');
    // Copy mode renders its rows as raw DOM, where React's own blocking of a
    // `javascript:` href does not apply — so the allowlist is the only guard.
    const href = safeHref(run.link.url);
    if (href) {
      a.href = href;
      a.title = href;
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.draggable = false;
    node = a;
  } else {
    node = document.createElement('span');
  }
  const { className, style } = runPaint(run);
  if (className) node.className = className;
  Object.assign(node.style, style);

  let glyph: Node = document.createTextNode(run.text);
  if (run.fit !== null) {
    const fit = document.createElement('span');
    fit.className = 'terminal-fit-glyph';
    fit.style.setProperty('--glyph-fit', String(run.fit));
    fit.appendChild(glyph);
    glyph = fit;
  }
  if (run.style?.size) {
    const scaled = document.createElement('span');
    scaled.className = 'terminal-scaled-text';
    scaled.dataset.size = run.style.size;
    scaled.appendChild(glyph);
    glyph = scaled;
  }
  node.appendChild(glyph);
  return node;
}

/**
 * Render a cell line into a DOM element, replacing its children.
 */
export function renderLineToDOM(
  el: HTMLDivElement,
  line: CellLine,
  selRange: SelectionCols | null,
  // The row's links when the caller detected them over the logical line
  // (`detectUrlsAcrossRows`); absent, the row detects its own.
  rowUrls?: DetectedUrl[],
): void {
  el.textContent = '';
  // Reset inline background so stale colors don't persist across updates
  el.style.backgroundColor = '';

  if (line.length === 0) return;

  // When apps like neovim set a theme background (e.g. #1e1e2e), empty cells
  // and line gaps would otherwise show the container's background between
  // the scroll view's absolutely placed rows.
  const lineBg = detectLineBg(line);
  if (lineBg) el.style.backgroundColor = lineBg;

  for (const run of cellRuns(line, selRange, rowUrlIndex(line, rowUrls))) {
    el.appendChild(runNode(run));
  }

  const pad = selectionPad(line, selRange);
  if (pad > 0) {
    const span = document.createElement('span');
    span.className = 'terminal-selected';
    span.textContent = ' '.repeat(pad);
    el.appendChild(span);
  }
}
