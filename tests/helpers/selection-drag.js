/**
 * Selecting terminal text with the pointer, in the coordinates the user drags
 * through.
 *
 * A selection test has to press and release on real pixels: the browser starts
 * and ends a selection at the nearest character boundary, so a press in the
 * middle of the first letter leaves that letter out. `runRect` returns the
 * outer edges of a rendered run, and `dragSelect` sweeps between them.
 *
 * Shared by the suites that drive a browser of their own (own-browser.js);
 * the same geometry is computed inline in tests/1-input-interaction.test.js
 * for the Chromium run.
 */

const { delay } = require('./browser');

/**
 * Where the last line containing `text` is on screen, and the two x positions
 * a drag over exactly that text starts and ends at.
 *
 * `box` is the run's own rectangle — what a copy blink or a selection
 * highlight has to line up with.
 */
async function runRect(page, rootSelector, text) {
  return await page.evaluate(
    ({ sel, needle }) => {
      const root = [...document.querySelectorAll(sel)].find((el) =>
        (el.textContent || '').includes(needle),
      );
      if (!root) return null;
      const lines = [...root.querySelectorAll('.terminal-line')].filter((l) =>
        (l.textContent || '').includes(needle),
      );
      const line = lines[lines.length - 1];
      if (!line) return null;
      const r = line.getBoundingClientRect();
      const cellW = parseFloat(getComputedStyle(line).getPropertyValue('--cell-w'));
      const before = (line.textContent || '').indexOf(needle);
      const left = r.left + before * cellW;
      return {
        y: r.top + r.height / 2,
        // Just inside the outer edges of the first and last cell.
        first: left + 1,
        last: left + needle.length * cellW - 1,
        box: { left, right: left + needle.length * cellW, top: r.top, bottom: r.bottom },
      };
    },
    { sel: rootSelector, needle: text },
  );
}

/** Press, sweep and release, pausing on the end so a throttled move lands there. */
async function dragSelect(page, at) {
  await page.mouse.move(at.first, at.y);
  await page.mouse.down();
  await page.mouse.move(at.last, at.y, { steps: 10 });
  await delay(120);
  await page.mouse.move(at.last + 0.5, at.y);
  await page.mouse.up();
}

/** What the browser says is selected right now, '' when nothing is. */
async function selectedText(page) {
  return await page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/**
 * The selection as the user SEES it: the rectangle its range paints over, or
 * null when the selection is gone or collapsed. A selection that exists but
 * covers no pixels is not a selection anyone can point at.
 */
async function selectionRect(page) {
  return await page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const r = selection.getRangeAt(0).getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
}

module.exports = { runRect, dragSelect, selectedText, selectionRect };
