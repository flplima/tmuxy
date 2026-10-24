/**
 * Selecting terminal text with the pointer, in the coordinates the user drags
 * through.
 *
 * A selection test has to press and release on real pixels: the browser starts
 * and ends a selection at the nearest character boundary, so a press in the
 * middle of the first letter leaves that letter out. `runRect` returns the
 * outer edges of a rendered run, and `dragSelect` sweeps between them.
 *
 * Shared by the suites that drive a browser of their own (own-browser.js) and
 * by the Chromium selection suite (1-input-interaction-clipboard.test.js).
 */

const { delay, waitForCondition } = require('./browser');

/**
 * Where the last line SHOWN containing `text` is on screen, and the two x
 * positions a drag over exactly that text starts and ends at.
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
      const lines = [...root.querySelectorAll('.terminal-line')].filter(
        (l) => l.getBoundingClientRect().height > 0 && (l.textContent || '').includes(needle),
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

/**
 * `runRect` once a line containing `text` is on screen WITH the shell's
 * prompt drawn below it. runCommand's text wait is met by the typed command
 * line, which merely CONTAINS the marker; the output line can still be on its
 * way — and so can the prompt after it, whose rows scroll everything measured
 * before they arrived. A drag aimed at a row measured then pressed two rows
 * too low and selected the wrong line.
 */
async function shownRunRect(page, rootSelector, text) {
  let found = null;
  await waitForCondition(
    page,
    async () => {
      const prompted = await page.evaluate(
        ({ sel, needle }) => {
          const lines = [...document.querySelectorAll(`${sel} .terminal-line`)].filter(
            (l) => l.getBoundingClientRect().height > 0,
          );
          const at = lines.findIndex((l) => (l.textContent || '').includes(needle));
          return at >= 0 && lines.slice(at + 1).some((l) => /[$#%>❯]/.test(l.textContent));
        },
        { sel: rootSelector, needle: text },
      );
      if (!prompted) return false;
      return (found = await runRect(page, rootSelector, text)) !== null;
    },
    10000,
    `a line with ${text}, with the prompt back below it`,
  );
  return found;
}

/**
 * Press on `from`'s first cell, sweep to `to`'s last cell (the same run when
 * `to` is omitted) and release, pausing on the end so a throttled move lands
 * there.
 */
async function dragSelect(page, from, to = from) {
  await page.mouse.move(from.first, from.y);
  await page.mouse.down();
  await page.mouse.move(to.last, to.y, { steps: 10 });
  await delay(120);
  await page.mouse.move(to.last + 0.5, to.y);
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

/**
 * Records what each copy puts on the clipboard, read off the copy event after
 * the app's own handler has set it: the system clipboard needs a permission no
 * headless browser grants. `copiedText` is null until a copy happens.
 */
async function recordCopies(page) {
  await page.evaluate(() => {
    window.__copied = null;
    window.addEventListener('copy', (e) => {
      window.__copied = e.clipboardData.getData('text/plain');
    });
  });
}

async function copiedText(page) {
  return await page.evaluate(() => window.__copied);
}

module.exports = {
  runRect,
  shownRunRect,
  dragSelect,
  selectedText,
  selectionRect,
  recordCopies,
  copiedText,
};
