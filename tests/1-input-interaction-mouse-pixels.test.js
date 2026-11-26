/**
 * Input & Interaction E2E Tests (mouse in pixels, and moves with no button held)
 *
 * A program in a pane turns on any-motion tracking (`?1003h`) and, in the
 * first case, SGR-Pixels (`?1016h`). The real pointer moves and clicks over
 * the pane; the program prints every report it reads, and the test reads
 * what it printed on the pane as the user sees it.
 */

const {
  describeE2E,
  waitForShellPrompt,
  waitForCondition,
  startMouseCapture,
  readMouseEvents,
  stopMouseCapture,
  ensureMouseCaptureStopped,
} = require('./helpers');

/** The active pane's cell grid as drawn: its top-left corner and one cell's size. */
async function gridOf(page) {
  const grid = await page.evaluate(() => {
    const root =
      document.querySelector('.pane-active') ?? document.querySelector('.pane-layout-item');
    const box = root.querySelector('.pane-scroll-container').getBoundingClientRect();
    const line = root.querySelector('.terminal-line');
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      cellW: parseFloat(getComputedStyle(line).getPropertyValue('--cell-w')),
      cellH: line.getBoundingClientRect().height,
    };
  });
  expect(grid.width).toBeGreaterThan(100);
  expect(grid.height).toBeGreaterThan(100);
  return grid;
}

/**
 * A point `dx`, `dy` CSS pixels into the grid, put on a whole client pixel:
 * the browser reports the pointer at whole pixels, and the grid's corner may
 * sit between two. `expected` is the 1-based pixel a report should carry.
 */
function pointIn(grid, dx, dy) {
  const x = Math.round(grid.x + dx);
  const y = Math.round(grid.y + dy);
  return { x, y, expected: { x: x - grid.x + 1, y: y - grid.y + 1 } };
}

/** Wait until the UI knows the pane's mouse modes, so no report goes out in the old ones. */
async function waitForModes(page, { all, pixels }) {
  await waitForCondition(
    page,
    () =>
      page.evaluate(
        ([a, p]) =>
          !!document.querySelector(
            `[data-mouse-any-flag="true"][data-mouse-all-flag="${a}"][data-mouse-pixels-flag="${p}"]`,
          ),
        [all, pixels],
      ),
    15000,
    `the pane to report any-motion ${all} and pixels ${pixels}`,
  );
}

/** Wait for a new event of `type` past the first `seen` and return it. */
async function nextEvent(page, type, seen) {
  return waitForCondition(
    page,
    async () => {
      const events = (await readMouseEvents(0, 200)).filter((e) => e.type === type);
      return events.length > seen ? events[events.length - 1] : null;
    },
    5000,
    `the program to read a ${type} report`,
  );
}

const count = async (type) => (await readMouseEvents(0, 200)).filter((e) => e.type === type).length;

/**
 * The line the program printed for `event`, as the user sees it: inside the
 * pane's grid, with a size.
 */
async function assertPrintedVisibly(page, event) {
  const text = `${event.type}:btn=${event.btn}:x=${event.x}:y=${event.y}`;
  await waitForCondition(
    page,
    () =>
      page.evaluate((wanted) => {
        const root =
          document.querySelector('.pane-active') ?? document.querySelector('.pane-layout-item');
        const box = root.querySelector('.pane-scroll-container').getBoundingClientRect();
        return [...root.querySelectorAll('.terminal-line')].some((line) => {
          if (!line.textContent.includes(wanted)) return false;
          const r = line.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.top >= box.top - 1 &&
            r.bottom <= box.bottom + 1 &&
            r.left >= box.left - 1
          );
        });
      }, text),
    5000,
    `"${text}" to show in the pane`,
  );
}

describeE2E('Scenario 7d: A program asks for the mouse in pixels and for every move', {}, (ctx) => {
  afterEach(async () => {
    await ensureMouseCaptureStopped(ctx);
  }, ctx.hookTimeout);

  test('with 1003 and 1016 the program hears hover moves and a click at the pixel under the pointer', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    await startMouseCapture(ctx, { modes: [1003, 1006, 1016] });
    await waitForModes(ctx.page, { all: true, pixels: true });
    const grid = await gridOf(ctx.page);
    const page = ctx.page;

    // Hover: no button held, the pointer crosses the pane. The program gets
    // moves (button 3), and the last says where the pointer stopped.
    const moves = await count('move');
    const stop = pointIn(grid, 7 * grid.cellW + 3.4, 4 * grid.cellH + 5.6);
    await page.mouse.move(grid.x + 2 * grid.cellW, grid.y + 2 * grid.cellH);
    await page.mouse.move(stop.x, stop.y, { steps: 6 });
    const hover = await waitForCondition(
      page,
      async () => {
        const seen = (await readMouseEvents(0, 200)).filter((e) => e.type === 'move');
        const last = seen[seen.length - 1];
        return seen.length > moves &&
          Math.abs(last.x - stop.expected.x) <= 1 &&
          Math.abs(last.y - stop.expected.y) <= 1
          ? last
          : null;
      },
      5000,
      async () =>
        `a move report near ${JSON.stringify(stop.expected)}, got ` +
        JSON.stringify((await readMouseEvents(0, 200)).slice(-4)),
    );
    expect(hover.btn).toBe(3);
    await assertPrintedVisibly(page, hover);

    // A click: press and release in pixels, 1-based from the grid's corner.
    const at = pointIn(grid, 23 * grid.cellW + 5.3, 9 * grid.cellH + 2.7);
    const presses = await count('press');
    const releases = await count('release');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const press = await nextEvent(page, 'press', presses);
    await page.mouse.up();
    const release = await nextEvent(page, 'release', releases);
    for (const report of [press, release]) {
      expect(report.btn).toBe(0);
      expect(Math.abs(report.x - at.expected.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(report.y - at.expected.y)).toBeLessThanOrEqual(1);
    }
    // In pixels, not cells: a cell report would be 24 here.
    expect(press.x).toBeGreaterThan(grid.cellW * 23);
    await assertPrintedVisibly(page, release);

    await stopMouseCapture(ctx);
  }, 120000);

  test('with 1003 alone the program hears hover moves in cells', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    await startMouseCapture(ctx, { modes: [1003, 1006] });
    await waitForModes(ctx.page, { all: true, pixels: false });
    const grid = await gridOf(ctx.page);
    const page = ctx.page;

    const moves = await count('move');
    const col = 12;
    const row = 5;
    await page.mouse.move(grid.x + 2 * grid.cellW, grid.y + 2 * grid.cellH);
    await page.mouse.move(grid.x + (col + 0.5) * grid.cellW, grid.y + (row + 0.5) * grid.cellH, {
      steps: 5,
    });
    const hover = await waitForCondition(
      page,
      async () => {
        const seen = (await readMouseEvents(0, 200)).filter((e) => e.type === 'move');
        const last = seen[seen.length - 1];
        return seen.length > moves && last.x === col + 1 && last.y === row + 1 ? last : null;
      },
      5000,
      async () =>
        `a move report at ${col + 1},${row + 1}, got ` +
        JSON.stringify((await readMouseEvents(0, 200)).slice(-4)),
    );
    expect(hover.btn).toBe(3);
    await assertPrintedVisibly(page, hover);

    // Moving inside that one cell says nothing new.
    const settled = await count('move');
    await page.mouse.move(grid.x + (col + 0.8) * grid.cellW, grid.y + (row + 0.6) * grid.cellH);
    const presses = await count('press');
    await page.mouse.down();
    await nextEvent(page, 'press', presses);
    await page.mouse.up();
    // The press went after the in-cell move, and the stream is ordered: had
    // the move been sent, the program would have read it by now.
    expect(await count('move')).toBe(settled);

    await stopMouseCapture(ctx);
  }, 120000);
});
