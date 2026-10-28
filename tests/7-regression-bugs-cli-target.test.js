/**
 * Regression Tests for Production Bugs (CLI target)
 *
 * `tmuxy pane split` run from a pane whose tab is not the active one split
 * the ACTIVE tab: tmux resolves a target-less command from an unattached
 * client — every `tmux` the CLI spawns inside run-shell is one — to the
 * session's current window, not to the pane named by TMUX_PANE. The CLI now
 * names the caller's pane on every pane- and window-scoped command.
 */

const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  waitForPaneCount,
  waitForWindowCount,
  waitForCondition,
} = require('./helpers');
const { TMUXY_CLI } = require('./helpers/cli');

describe('Scenario: a CLI split from a background tab lands in that tab', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('tab create, then pane split from the pane left behind: two panes in its tab, one in the new one', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    const panesByWindow = async () => {
      const counts = {};
      const out = await ctx.session.query("list-panes -s -F '#{window_id}'");
      for (const line of String(out).split('\n')) {
        if (line) counts[line] = (counts[line] || 0) + 1;
      }
      return counts;
    };
    const visibleWindow = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);
    const visiblePaneRects = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.pane-layout-item[data-pane-id]')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            left: Math.round(r.left),
            top: Math.round(r.top),
            width: Math.round(r.width),
          })),
      );

    const [firstWindow] = Object.keys(await panesByWindow());
    expect(await visibleWindow()).toBe(firstWindow);

    // One line, typed in the first tab's pane: the tab create makes the new
    // tab current, so the split that follows is asked for by a pane whose
    // tab is no longer the active one.
    await typeInTerminal(page, `${TMUXY_CLI} tab create other && ${TMUXY_CLI} pane split -h`);
    await pressEnter(page);
    await waitForWindowCount(page, 2);
    await waitForCondition(
      page,
      async () => (await panesByWindow())[firstWindow] === 2,
      15000,
      async () =>
        `the split to land in ${firstWindow} (panes: ${JSON.stringify(await panesByWindow())})`,
    );
    const counts = await panesByWindow();
    const [newWindow] = Object.keys(counts).filter((w) => w !== firstWindow);
    expect(counts[newWindow]).toBe(1);

    // What the user sees: the new tab is in front with its single pane…
    expect(await visibleWindow()).toBe(newWindow);
    await waitForPaneCount(page, 1);
    expect(await visiblePaneRects()).toHaveLength(1);

    // …and the first tab, brought back by a click on it, shows its two panes
    // side by side.
    await page.click('.tab-name:nth-child(1)');
    await waitForCondition(
      page,
      async () => (await visibleWindow()) === firstWindow,
      10000,
      'the first tab back in front',
    );
    await waitForPaneCount(page, 2, 10000);
    const rects = await visiblePaneRects();
    expect(rects).toHaveLength(2);
    const [left, right] = rects.sort((a, b) => a.left - b.left);
    expect(left.top).toBe(right.top);
    expect(right.left).toBeGreaterThanOrEqual(left.left + left.width);
  }, 90000);
});
