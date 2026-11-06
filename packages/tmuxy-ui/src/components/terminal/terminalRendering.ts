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
 * The background more than half the row shares: a neovim/lazyvim theme
 * background, not syntax highlighting on a few cells.
 */
function detectLineBg(line: CellLine): string | null {
  if (line.length === 0) return null;

  const firstBg = line[0].s?.bg;
  if (firstBg === undefined) return null;

  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (sameCellColor(line[i].s?.bg, firstBg)) count++;
  }
  if (count > line.length / 2) {
    return cellColorToCss(firstBg);
  }
  return null;
}

function runNode(run: CellRun): HTMLElement {
  let node: HTMLElement;
  if (run.link) {
    const a = document.createElement('a');
    // Raw DOM: React's own blocking of a `javascript:` href does not apply,
    // so the allowlist is the only guard.
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

export function renderLineToDOM(
  el: HTMLDivElement,
  line: CellLine,
  selRange: SelectionCols | null,
  // Absent, the row detects its own.
  rowUrls?: DetectedUrl[],
): void {
  el.textContent = '';
  el.style.backgroundColor = '';

  if (line.length === 0) return;

  // Otherwise a neovim theme background shows the container's between the
  // absolutely placed rows.
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
