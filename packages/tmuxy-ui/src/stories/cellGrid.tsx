/**
 * Cell-grid scaffolding for component stories that render terminal content
 * without the app (TerminalLine, Cursor).
 *
 * In the app the size actor measures the terminal font once and App.tsx
 * publishes `--cell-w` / `--cell-gap` on the root. Stories that mount a bare
 * component have no actor, so this decorator performs the same measurement on
 * its own element (utils/cellMetrics.ts — the very function the app uses) and
 * publishes the same variables, giving the story the snapped grid the real
 * terminal renders on. Play functions can then assert geometry in cells.
 */

import { useCallback, type CSSProperties, type ReactNode } from 'react';
import { measureCellMetrics } from '../utils/cellMetrics';

function publish(el: HTMLElement): void {
  const m = measureCellMetrics(el);
  el.style.setProperty('--cell-w', `${m.cellWidth}px`);
  el.style.setProperty('--cell-gap', `${m.cellGap}px`);
}

export function CellGridDecorator({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  // A ref callback runs at commit, before paint — the variables exist for the
  // first frame. The webfont may still be loading then (font-display: swap),
  // so measure again once it has, exactly like the app's size actor does.
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    publish(el);
    document.fonts.ready.then(() => {
      if (el.isConnected) publish(el);
    });
  }, []);
  return (
    <div
      ref={ref}
      className="terminal-container"
      style={{
        background: '#0f0f12',
        color: '#e5e5e5',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Resolve once the webfont is in and the post-load re-measure has painted. */
export async function cellGridReady(): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/** The published cell width, read back from the grid element. */
export function cellWidthOf(grid: HTMLElement): number {
  const w = parseFloat(getComputedStyle(grid).getPropertyValue('--cell-w'));
  if (!(w > 0)) throw new Error(`--cell-w not published on grid (got "${w}")`);
  return w;
}

/**
 * Geometry of one rendered run, in cells, relative to its line's left edge.
 * `box` is the span's own box (pinned to an exact cell count); `ink` is the
 * inline box of the text inside it — the glyph advance — which for a wide
 * character exceeds the box and spills into the continuation cell.
 */
export function runCells(
  span: HTMLElement,
  cellW: number,
): { start: number; box: number; ink: number } {
  const line = span.closest('.terminal-line') as HTMLElement;
  const left = line.getBoundingClientRect().left;
  const r = span.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(span);
  const ink = range.getBoundingClientRect().width;
  return { start: (r.left - left) / cellW, box: r.width / cellW, ink: ink / cellW };
}
