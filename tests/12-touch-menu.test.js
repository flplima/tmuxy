/**
 * The phone's menu: under the keys, three views side by side — the app menu,
 * the tree, the side pane — picked by the tab bar along the bottom or by a
 * sideways swipe, the tree in front to begin with. The menu is the app menu
 * as a phone list: a submenu is a page of its own, with the way back at the
 * top, and an item does what it does on a desktop.
 */

const {
  PHONE,
  phoneContext,
  expectOnScreen,
  swipeSideways,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { describeE2E, waitForCondition } = require('./helpers');

/** What the bottom view shows: which view, the menu's title and rows, the tree's tabs. */
const bottomState = (page) =>
  page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= window.innerWidth + 1;
    };
    const bottom = document.querySelector('[data-testid="phone-bottom"]');
    return {
      view: bottom?.dataset.view ?? null,
      sliding: bottom?.dataset.sliding ?? null,
      selected: document.querySelector('.phone-tabs [aria-selected="true"]')?.dataset.view ?? null,
      title: document.querySelector('.phone-menu-title')?.textContent ?? null,
      back: document.querySelector('.phone-menu-back')?.getAttribute('aria-label') ?? null,
      rows: [...document.querySelectorAll('.phone-menu-page .phone-menu-row')]
        .filter(visible)
        .map((r) => r.textContent.trim()),
      tabs: document.querySelectorAll('.phone-tree .sidebar-tree-tab').length,
    };
  });

/** Tap the centre of the first visible element matching `selector` whose text is `text`. */
async function tapText(page, selector, text) {
  const point = await page.evaluate(
    ({ s, t }) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === t);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { s: selector, t: text },
  );
  if (!point) throw new Error(`nothing to tap: ${selector} "${text}"`);
  await page.touchscreen.tap(point.x, point.y);
}

describeE2E(
  'Phone width (390px) with a touchscreen: the menu',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('the tab bar and a slide pick the menu, the tree or the side pane; a submenu is a page with the way back, and its item runs', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);
      const page = ctx.page;
      let state = null;
      const until = (check, what) =>
        waitForCondition(
          page,
          async () => check((state = await bottomState(page))),
          10000,
          () => `${what} (last: ${JSON.stringify(state)})`,
        );

      // 1. The tree is in front, its tab lit in the bar along the bottom.
      await until((s) => s.view === 'tree' && s.selected === 'tree' && s.tabs >= 1, 'the tree');
      const tabsBefore = state.tabs;
      expectOnScreen(await boxOf(page, '.phone-tabs'), 'the tab bar');

      // 2. The Menu tab: the app menu's top page, its submenus as rows.
      await tapText(page, '.phone-tab', 'Menu');
      await until(
        (s) => s.view === 'menu' && s.selected === 'menu' && s.title === 'Menu',
        'the menu in front',
      );
      expect(state.back).toBeNull();
      for (const row of ['Pane', 'Tab', 'Session', 'View']) expect(state.rows).toContain(row);
      const menu = await boxOf(page, '.phone-menu');
      expectOnScreen(menu, 'the menu');
      expect(menu.bottom).toBeLessThanOrEqual((await boxOf(page, '.phone-tabs')).top + 1);

      // 3. Tab: a page of its own, titled for it, with the way back to the menu.
      await tapText(page, '.phone-menu-row', 'Tab');
      await until((s) => s.title === 'Tab' && s.rows.includes('New Tab'), 'the Tab page');
      expect(state.back).toBe('Back to Menu');
      expect(state.rows).not.toContain('Session');

      // 4. Its item does what the desktop's does: a new tab, and the page stays.
      await tapText(page, '.phone-menu-row', 'New Tab');
      await waitForCondition(
        page,
        () =>
          page.evaluate(
            (n) => window.app.view().windows.filter((w) => w.kind === 'tab').length === n,
            tabsBefore + 1,
          ),
        10000,
        'New Tab to open a tab',
      );
      await until((s) => s.title === 'Tab', 'the Tab page to stay');

      // 5. Back: the top page again.
      await page.touchscreen.tap(
        ...(await page.evaluate(() => {
          const r = document.querySelector('.phone-menu-back').getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2];
        })),
      );
      await until((s) => s.title === 'Menu' && s.back === null, 'the way back to the top page');

      // 6. The Tree tab brings the tree back in front, listing the new tab.
      await tapText(page, '.phone-tab', 'Tree');
      await until((s) => s.view === 'tree' && s.selected === 'tree', 'the Tree tab');
      await until((s) => s.tabs === tabsBefore + 1, 'the tree to list the new tab');

      // 7. A slide: right from the tree is the menu, right again from the menu,
      //    the left end, goes nowhere, and left from the menu is the tree. Last,
      //    because Chrome can draw no click for a tap that lands a moment after
      //    a swipe, so no tap here follows one.
      const y = (await boxOf(page, '.phone-bottom-stage')).top + 60;
      await swipeSideways(page, y, 60, 330);
      await until(
        (s) => s.view === 'menu' && s.selected === 'menu' && !s.sliding,
        'the slide to the menu',
      );
      await swipeSideways(page, y, 60, 330);
      await until((s) => s.view === 'menu' && !s.sliding, 'the menu to stay at the left end');
      await swipeSideways(page, y, 330, 60);
      await until(
        (s) => s.view === 'tree' && s.selected === 'tree' && !s.sliding,
        'the slide back to the tree',
      );
    }, 120000);
  },
);
