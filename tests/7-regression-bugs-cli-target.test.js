/**
 * Regression Tests for Production Bugs (CLI target)
 *
 * `tmuxy pane split` run from a pane whose tab is not the active one split
 * the ACTIVE tab: tmux resolves a target-less command from an unattached
 * client — every `tmux` the CLI spawns inside run-shell is one — to the
 * session's current window, not to the pane named by TMUX_PANE. The CLI now
 * names the caller's pane on every pane- and window-scoped command.
 *
 * The pane-group verbs leave `#{pane_id}` for run-shell to expand, and
 * run-shell expands it against ITS target — the same current window when it
 * has none. The caller's pane is now run-shell's target too.
 */

const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  waitForPaneCount,
  waitForWindowCount,
  waitForCondition,
  getGroupTabCount,
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

  test('tab create, then pane group add from the pane left behind: the group forms in its tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    const visibleWindow = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);
    const visibleGroupTabRects = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.pane-tabs .pane-tab')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ left: Math.round(r.left), top: Math.round(r.top) })),
      );

    const firstWindow = await visibleWindow();
    await typeInTerminal(page, `${TMUXY_CLI} tab create other && ${TMUXY_CLI} pane group add`);
    await pressEnter(page);
    await waitForWindowCount(page, 2);
    const newWindow = await waitForCondition(
      page,
      async () => {
        const w = await visibleWindow();
        return w !== firstWindow ? w : null;
      },
      10000,
      'the new tab in front',
    );

    // Which panes carry a group id is a session-wide read, so it says where
    // the group went before any tab is clicked: it is the first tab's pane,
    // not the one in front, that gained a member.
    const groupedWindows = async () => {
      const out = await ctx.session.query("list-panes -s -F '#{window_id} #{@tmuxy-group-id}'");
      return String(out)
        .split('\n')
        .map((line) => line.trim().split(' '))
        .filter(([, group]) => group)
        .map(([window]) => window);
    };
    await waitForCondition(
      page,
      async () => (await groupedWindows()).includes(firstWindow),
      15000,
      async () => `the first tab's pane to join a group (grouped: ${await groupedWindows()})`,
    );
    expect(await groupedWindows()).not.toContain(newWindow);

    // What the user sees: the tab in front has a plain pane, one header tab
    // of its own and no group…
    expect(await getGroupTabCount(page)).toBe(0);
    expect(await visibleGroupTabRects()).toHaveLength(1);

    // …and the first tab, brought back, shows two group tabs in one header row.
    await page.click('.tab-name:nth-child(1)');
    await waitForCondition(
      page,
      async () => (await visibleWindow()) === firstWindow,
      10000,
      'the first tab back in front',
    );
    await waitForCondition(
      page,
      async () => (await getGroupTabCount(page)) === 2,
      10000,
      'two group tabs in the first tab',
    );
    const tabs = await visibleGroupTabRects();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].top).toBe(tabs[1].top);
    expect(tabs[0].left).not.toBe(tabs[1].left);
  }, 90000);
});
