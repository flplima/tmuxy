/**
 * Cell-grid geometry helpers — what the user SEES on the terminal grid, in
 * cells.
 *
 * The UI publishes the snapped cell width as `--cell-w` on `.app-container`
 * (tmuxy-ui/src/infra/dom/cellMetrics.ts). Everything here converts bounding rects
 * into that unit so a test can compare rendered positions with tmux's own
 * cell coordinates (`#{cursor_x}`), which is the real oracle for "does the
 * browser grid match tmux".
 */

const { storyModule, inPage } = require('./story-module');

const { cellWidthOf, runCells } = storyModule('cellGridHelpers.ts');

/** Snapped cell width in CSS px, as published to the DOM. */
async function getCellWidth(page) {
  return page.evaluate(
    inPage((cellWidth) => cellWidth(document.querySelector('.app-container')), [], [cellWidthOf]),
  );
}

/**
 * The grid's cell as drawn: `--cell-w`, and the height of one of the active
 * pane's rows (of any terminal's, before a pane is active).
 */
async function getCellSize(page) {
  const size = await page.evaluate(() => {
    const root = document.querySelector('.app-container');
    const row =
      document.querySelector('.pane-active .terminal-line') ||
      document.querySelector('.terminal-line');
    return {
      charWidth: root ? parseFloat(getComputedStyle(root).getPropertyValue('--cell-w')) : NaN,
      charHeight: row ? row.getBoundingClientRect().height : NaN,
    };
  });
  if (!(size.charWidth > 0 && size.charHeight > 0)) {
    throw new Error(`no cell drawn to measure (got ${JSON.stringify(size)})`);
  }
  return size;
}

/**
 * The active pane's cursor overlay: its cell address (data attributes) and
 * where it is actually painted, in cells from the left edge of the content.
 */
async function getCursorGeometry(page) {
  const geo = await page.evaluate(() => {
    const cursor =
      document.querySelector('.pane-active .terminal-cursor') ||
      document.querySelector('.terminal-cursor');
    if (!cursor) return null;
    const content = cursor.parentElement.querySelector('.terminal-content');
    const root = document.querySelector('.app-container');
    const cellW = parseFloat(getComputedStyle(root).getPropertyValue('--cell-w'));
    const c = content.getBoundingClientRect();
    const r = cursor.getBoundingClientRect();
    return {
      x: Number(cursor.getAttribute('data-cursor-x')),
      y: Number(cursor.getAttribute('data-cursor-y')),
      col: (r.left - c.left) / cellW,
      cols: r.width / cellW,
      visible: r.width > 0 && r.height > 0,
    };
  });
  if (!geo) throw new Error('no cursor overlay rendered in the active pane');
  return geo;
}

/**
 * Geometry of the rendered run containing `text`, in cells relative to its
 * line. Searches the LAST line of the active pane that contains the text (the
 * command's output sits below the echoed command line).
 *
 * - `start` / `end`: the run's box edges (pinned to whole cells)
 * - `box`: box width in cells
 * - `ink`: the text's own inline box — the glyph advance. For a wide character
 *   this exceeds the 1-cell box and spills into the continuation cell.
 */
async function getRunGeometry(page, text) {
  const geo = await page.evaluate(
    inPage(
      (needle, cellWidth, cellsOf) => {
        const content =
          document.querySelector('.pane-active .terminal-content') ||
          document.querySelector('.terminal-content');
        if (!content) return null;
        const lines = Array.from(content.querySelectorAll('.terminal-line')).filter((l) =>
          (l.textContent || '').includes(needle),
        );
        const line = lines[lines.length - 1];
        const run =
          line && Array.from(line.children).find((s) => (s.textContent || '').includes(needle));
        if (!run) return null;
        const cells = cellsOf(run, cellWidth(document.querySelector('.app-container')));
        const r = run.getBoundingClientRect();
        return {
          text: run.textContent,
          ...cells,
          end: cells.start + cells.box,
          visible: r.width > 0 && r.height > 0,
        };
      },
      [text],
      [cellWidthOf, runCells],
    ),
  );
  if (!geo) throw new Error(`no rendered run containing ${JSON.stringify(text)}`);
  return geo;
}

module.exports = {
  getCellSize,
  getCellWidth,
  getCursorGeometry,
  getRunGeometry,
};
