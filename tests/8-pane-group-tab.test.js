/**
 * `tmuxy pane group all` gathers every pane of a tab into one group, and
 * `tmuxy pane group ungroup` lets them back out as splits: the whole tab, in
 * two commands, from the shell inside it.
 */

const {
  describeE2E,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  getGroupTabCount,
  createWindowKeyboard,
  activeWindowId,
  windowCount,
} = require('./helpers');
const { TMUXY_CLI } = require('./helpers/cli');

/** The session a group's hidden members are parked in (tmuxy-core `STASH_SESSION`). */
const STASH_SESSION = '__tmuxy_stash';

describeE2E('Pane groups: a whole tab in and out of one group', {}, (ctx) => {
  test('three splits → group all → one pane with three group tabs → ungroup → three splits again, none grouped', async () => {
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

  /**
   * Closing a tab whose panes are one group: the member on screen dies with
   * the window, and the parked one — in the stash session, where a kill
   * sends no `pane-died` — goes with it instead of living on as a hidden
   * shell. Both ways a tab is closed: from its own shell (`tmuxy tab kill`)
   * and from the strip (right-click → "Close Tab").
   */
  test('closing a grouped tab takes its parked member with it, from the CLI and from the strip', async () => {
    await ctx.setupPage();
    const page = ctx.page;

    const visiblePanes = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('.pane-layout-item')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length,
      );
    const members = async (group) =>
      String(await ctx.session.query("list-panes -a -F '#{session_name} #{@tmuxy-group-id}'"))
        .split('\n')
        .map((line) => line.trim().split(' '))
        .filter(([, g]) => g === group)
        .map(([session]) => session);

    // A new tab, split in two and gathered into one group: one member on
    // screen, one parked in the stash. Returns the group's id.
    const groupedTab = async () => {
      await createWindowKeyboard(page);
      const windowId = await activeWindowId(page);
      await splitPaneKeyboard(page, 'horizontal');
      await waitForCondition(
        page,
        async () => (await visiblePanes()) === 2,
        8000,
        async () => `two panes in the new tab (panes: ${await visiblePanes()})`,
      );
      await typeInTerminal(page, `${TMUXY_CLI} pane group all`);
      await pressEnter(page);
      await waitForCondition(
        page,
        async () => (await getGroupTabCount(page)) === 2 && (await visiblePanes()) === 1,
        15000,
        async () =>
          `one pane with two group tabs (tabs: ${await getGroupTabCount(page)}, panes: ${await visiblePanes()})`,
      );
      const group = String(
        await ctx.session.query("list-panes -s -F '#{window_id} #{@tmuxy-group-id}'"),
      )
        .split('\n')
        .map((line) => line.trim().split(' '))
        .find(([w, g]) => w === windowId && g)?.[1];
      expect(group).toBeTruthy();
      expect((await members(group)).sort()).toEqual([STASH_SESSION, ctx.session.name].sort());
      return { windowId, group };
    };

    const closed = async (group, tabs) =>
      waitForCondition(
        page,
        async () => (await windowCount(page)) === tabs && (await members(group)).length === 0,
        15000,
        async () =>
          `the tab and the group's parked member gone (tabs: ${await windowCount(page)}, members: ${await members(group)})`,
      );

    const tabs = await windowCount(page);

    // 1. From the tab's own shell.
    const first = await groupedTab();
    await typeInTerminal(page, `${TMUXY_CLI} tab kill`);
    await pressEnter(page);
    await closed(first.group, tabs);

    // 2. From the strip.
    const second = await groupedTab();
    await page.click(`.tab-list .tab-name[data-window-id="${second.windowId}"]`, {
      button: 'right',
    });
    await page.locator('[role="menuitem"]', { hasText: 'Close Tab' }).click({ timeout: 5000 });
    await closed(second.group, tabs);
  }, 120000);
});
