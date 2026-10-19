/**
 * Measurements stories make against the cell grid CellGridDecorator mounts.
 */

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
