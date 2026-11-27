/**
 * Input & Interaction E2E Tests (the cell size in pixels)
 *
 * A program that reads the mouse in pixels needs the cell's size. The page
 * announces the cell it draws in `@tmuxy-cell-px`, which a program reads
 * with `tmuxy run display-message`; and it asks the terminal with `CSI 16 t`
 * and `CSI 14 t`, which tmuxy answers where tmux does not (before 3.4). The
 * test reads what the program printed on the pane, as the user sees it, and
 * holds it against the cell and the grid the page really draws.
 */

const path = require('path');
const {
  describeE2E,
  waitForShellPrompt,
  waitForCondition,
  typeInTerminal,
  pressEnter,
} = require('./helpers');

const QUERY_SCRIPT = path.join(__dirname, 'helpers', 'cell-size-query.py');

/** One side as the page writes it: up to two decimals (`domain/cellSize.ts`). */
const side = (px) => String(Math.round(px * 100) / 100);

/** The active pane's cell and grid as drawn. */
async function drawnGrid(page) {
  const grid = await page.evaluate(() => {
    const pane =
      document.querySelector('.pane-active') ?? document.querySelector('.pane-layout-item');
    const content = pane.querySelector('.terminal-content');
    const lines = [...content.querySelectorAll('.terminal-line')];
    const cellW = parseFloat(
      getComputedStyle(document.querySelector('.app-container')).getPropertyValue('--cell-w'),
    );
    return {
      cellW,
      cellH: lines[0].getBoundingClientRect().height,
      cols: Math.round(content.getBoundingClientRect().width / cellW),
      rows: lines.length,
    };
  });
  expect(grid.cellW).toBeGreaterThan(0);
  expect(grid.cellH).toBeGreaterThan(0);
  expect(grid.cols).toBeGreaterThan(10);
  expect(grid.rows).toBeGreaterThan(5);
  return grid;
}

/** The active pane's lines the user can see: inside its grid, with a size. */
function visibleLines(page) {
  return page.evaluate(() => {
    const pane =
      document.querySelector('.pane-active') ?? document.querySelector('.pane-layout-item');
    const box = pane.querySelector('.pane-scroll-container').getBoundingClientRect();
    return [...pane.querySelectorAll('.terminal-line')]
      .filter((line) => {
        const r = line.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      })
      .map((line) => line.textContent.trim());
  });
}

/** Type `command`, run it, and wait for a visible line `done` matches; every visible line after. */
async function runAndRead(page, command, done, what) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  return waitForCondition(
    page,
    async () => {
      const lines = await visibleLines(page);
      return lines.some((l) => done.test(l)) ? lines : null;
    },
    15000,
    async () => `${what}; the pane shows ${JSON.stringify((await visibleLines(page)).slice(-6))}`,
  );
}

describeE2E('Scenario 7e: A program learns the cell size in pixels', {}, (ctx) => {
  test('the size a program reads and is told matches the cell and grid the page draws', async () => {
    await ctx.setupPage();
    const page = ctx.page;
    await waitForShellPrompt(page);
    const grid = await drawnGrid(page);
    const announced = `${side(grid.cellW)}x${side(grid.cellH)}`;

    // The announcement reaches tmux and comes back in the state.
    await waitForCondition(
      page,
      () => page.evaluate((want) => window.app?.view?.().cellPx === want, announced),
      15000,
      async () =>
        `the page to announce ${announced}, the state says ` +
        JSON.stringify(await page.evaluate(() => window.app?.view?.().cellPx)),
    );

    // A program reads it with the CLI.
    const read = await runAndRead(
      page,
      "tmuxy run display-message -p 'cell=#{@tmuxy-cell-px}'",
      /^cell=\S+$/,
      'the CLI to print the cell size',
    );
    expect(read.filter((l) => /^cell=\S+$/.test(l))).toEqual([`cell=${announced}`]);

    // A program asks the terminal. tmux 3.4 and later answer themselves,
    // with their own size, so tmuxy stays silent: one answer to each query.
    const version = ctx.session.runCommand("display-message -p '#{version}'").trim();
    const [, major, minor] = /^(?:next-)?(\d+)\.(\d+)/.exec(version) ?? [null, '99', '0'];
    const tmuxAnswers = Number(major) * 100 + Number(minor) >= 304;
    const lines = await runAndRead(
      page,
      `python3 ${QUERY_SCRIPT}`,
      /^replies=\d+$/,
      'the query program to finish',
    );
    const replies = lines.filter((l) => l.startsWith('reply='));
    expect(lines).toContain('replies=2');
    expect(replies.map((r) => r.slice('reply='.length, 'reply='.length + 2)).sort()).toEqual([
      '4;',
      '6;',
    ]);
    if (!tmuxAnswers) {
      expect(replies).toEqual([
        `reply=6;${Math.round(grid.cellH)};${Math.round(grid.cellW)}`,
        `reply=4;${Math.round(grid.rows * grid.cellH)};${Math.round(grid.cols * grid.cellW)}`,
      ]);
    }
  }, 120000);
});
