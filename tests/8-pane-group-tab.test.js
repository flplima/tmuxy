/**
 * `tmuxy pane group all` gathers every pane of a tab into one group, and
 * `tmuxy pane group ungroup` lets them back out as splits: the whole tab, in
 * two commands, from the shell inside it.
 */

const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  getGroupTabCount,
} = require('./helpers');
const { TMUXY_CLI } = require('./helpers/cli');

describe('Pane groups: a whole tab in and out of one group', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('three splits → group all → one pane with three group tabs → ungroup → three splits again, none grouped', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 3);

    const visiblePanes = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('.pane-layout-item')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length,
      );
    // The panes sharing a group with one of this tab's panes. `-a`: the
    // parked members live in the stash session; other tests' groups may too,
    // so only this tab's group counts.
    const groupedPanes = async () => {
      const ours = String(await ctx.session.query("list-panes -s -F '#{@tmuxy-group-id}'"))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const out = await ctx.session.query("list-panes -a -F '#{pane_id} #{@tmuxy-group-id}'");
      return String(out)
        .split('\n')
        .map((line) => line.trim().split(' '))
        .filter(([, group]) => group && ours.includes(group))
        .map(([pane]) => pane);
    };

    // 1. all: the active pane keeps its slot, the other two park behind it as
    //    group tabs in one header row.
    await typeInTerminal(page, `${TMUXY_CLI} pane group all`);
    await pressEnter(page);
    await waitForCondition(
      page,
      async () => (await getGroupTabCount(page)) === 3 && (await visiblePanes()) === 1,
      15000,
      async () =>
        `one pane with three group tabs (tabs: ${await getGroupTabCount(page)}, panes: ${await visiblePanes()})`,
    );
    expect((await groupedPanes()).length).toBe(3);
    const header = await page.evaluate(() => {
      const r = document.querySelector('.pane-tabs').getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(header.width).toBeGreaterThan(0);
    expect(header.height).toBeGreaterThan(0);

    // 2. ungroup: the members come back as splits, the group is gone, the
    //    tab shares its space between the three.
    await typeInTerminal(page, `${TMUXY_CLI} pane group ungroup`);
    await pressEnter(page);
    await waitForCondition(
      page,
      async () => (await visiblePanes()) === 3 && (await getGroupTabCount(page)) === 0,
      15000,
      async () =>
        `three split panes and no group tabs (tabs: ${await getGroupTabCount(page)}, panes: ${await visiblePanes()})`,
    );
    await waitForCondition(
      page,
      async () => (await groupedPanes()).length === 0,
      10000,
      async () => `no pane to carry a group id (grouped: ${await groupedPanes()})`,
    );
    const rects = await page.evaluate(() =>
      [...document.querySelectorAll('.pane-layout-item')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          left: Math.round(r.left),
          top: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        })),
    );
    expect(rects).toHaveLength(3);
    // No two panes drawn on the same spot: every one has its own place.
    const spots = new Set(rects.map((r) => `${r.left},${r.top}`));
    expect(spots.size).toBe(3);
  }, 120000);
});
