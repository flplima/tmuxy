/**
 * Personalization E2E Tests
 *
 * What a user puts in `~/.config/tmuxy/` reaches the page without a reload: a
 * theme they copied, `custom.css`, a `@tmuxy-css-*` option, and a `tmuxy.conf`
 * edit applied by `tmuxy config reload`. A server with a scratch config dir
 * of its own is what makes the files safe to write.
 */

const fs = require('fs');
const path = require('path');
const { createTestContext, navigateToSession, waitForCondition } = require('./helpers');
const {
  CONFIG_URL,
  CONFIG_DIR,
  startConfigServer,
  reloadConfig,
  unsetConfigVariable,
} = require('./helpers/config-server');

/** The `--term-background` the page resolves, and the colour the active pane is painted. */
const painted = (page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const pane = document.querySelector('.pane-layout-item.pane-active');
    return {
      termBackground: root.getPropertyValue('--term-background').trim(),
      appOpacity: root.getPropertyValue('--app-opacity').trim(),
      paneBackground: pane ? getComputedStyle(pane).backgroundColor : null,
      themeHref: document.getElementById('tmuxy-theme')?.getAttribute('href') ?? null,
    };
  });

const noMenuOpen = (page) =>
  page.evaluate(() => document.querySelector('[role^="menuitem"]') === null);

/**
 * Open the hamburger menu — once nothing of a previous one is left, since the
 * button toggles and a menu that is still leaving would take the click as a
 * close — and click the entry `label` names, going through a submenu first.
 */
async function clickMenuItem(page, labels) {
  await waitForCondition(page, () => noMenuOpen(page), 5000, 'the previous menu to close');
  await page.click('.app-menu-button');
  for (const label of labels) {
    const item = page.locator('[role^="menuitem"]', { hasText: label }).first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.click();
  }
}

/** The theme submenu's items, with whether each one can be picked; closed again after. */
async function themeMenuItems(page) {
  await clickMenuItem(page, ['Theme']);
  await page.locator('[role^="menuitem"]', { hasText: 'Dark Mode' }).waitFor({ timeout: 5000 });
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('[role^="menuitem"]')].map((el) => ({
      text: el.textContent.trim(),
      disabled: el.getAttribute('aria-disabled') === 'true',
    })),
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitForCondition(page, () => noMenuOpen(page), 5000, 'the menu to close');
  return items;
}

describe('Scenario 31: Personalizing tmuxy from its config dir', () => {
  const ctx = createTestContext();
  let stopServer = () => {};

  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    stopServer();
    stopServer = () => {};
    unsetConfigVariable();
    await ctx.afterEach();
  }, ctx.hookTimeout);

  test('a copied theme is listed, picked, repainted on save, overridden by @tmuxy-css-* then custom.css, and tmuxy.conf reloads live', async () => {
    if (ctx.skipIfNotReady()) return;
    unsetConfigVariable();
    stopServer = await startConfigServer();
    const themes = path.join(CONFIG_DIR, 'themes');

    // The server materialized the config dir: the built-in themes are the
    // app's (headed so), and the guide is there for whoever opens the dir.
    const nord = fs.readFileSync(path.join(themes, 'nord.css'), 'utf8');
    expect(nord.startsWith('/* Shipped by tmuxy')).toBe(true);
    expect(fs.existsSync(path.join(CONFIG_DIR, 'README.md'))).toBe(true);

    // A custom theme is a copy under a new name — here with its own terminal
    // background and no light palette.
    const mine = nord
      .replace(/--term-background: #[0-9a-f]+;/, '--term-background: #123456;')
      .replace(/:root\.theme-light \{[^}]*\}/, ':root.theme-light {\n}');
    expect(mine).toContain('#123456');
    fs.writeFileSync(path.join(themes, 'e2e-mine.css'), mine);

    const page = ctx.page;
    await navigateToSession(page, ctx.session.name, CONFIG_URL);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    const before = await painted(page);

    // Listed by the menu because the file exists, and picked through it. The
    // list arrives after the connect, so it is awaited before the menu opens.
    await waitForCondition(
      page,
      () =>
        page.evaluate(() =>
          window.app.getSnapshot().context.availableThemes.some((t) => t.name === 'e2e-mine'),
        ),
      10000,
      'the themes list to arrive',
    );
    const listed = await themeMenuItems(page);
    expect(listed.some((item) => item.text.includes('E2e Mine'))).toBe(true);
    await clickMenuItem(page, ['Theme', 'E2e Mine']);
    await waitForCondition(
      page,
      async () => (await painted(page)).termBackground === '#123456',
      10000,
      async () =>
        `the copied theme to be applied; the page shows ${JSON.stringify(await painted(page))}, ` +
        `theme ${await page.evaluate(() => {
          const c = window.app.getSnapshot().context;
          let saved = null;
          try {
            saved = localStorage.getItem('tmuxy-theme-name');
          } catch (e) {
            saved = `unavailable: ${e.message}`;
          }
          return JSON.stringify({ name: c.themeName, mode: c.themeMode, saved });
        })}`,
    );
    let now = await painted(page);
    expect(now.themeHref).toContain('/themes/e2e-mine.css');
    expect(now.paneBackground).not.toBe(before.paneBackground);
    const paintedWithMine = now.paneBackground;

    // No light palette in the file: the menu greys Light Mode out, and
    // System with it.
    const items = await themeMenuItems(page);
    expect(items.find((i) => i.text.includes('Light Mode')).disabled).toBe(true);
    expect(items.find((i) => i.text.includes('System')).disabled).toBe(true);
    expect(items.find((i) => i.text.includes('Dark Mode')).disabled).toBe(false);

    // Saving the file repaints the page: no reload, no menu.
    fs.writeFileSync(path.join(themes, 'e2e-mine.css'), mine.replace('#123456', '#654321'));
    await waitForCondition(
      page,
      async () => (await painted(page)).termBackground === '#654321',
      10000,
      'the saved theme to repaint the page',
    );
    now = await painted(page);
    expect(now.paneBackground).not.toBe(paintedWithMine);
    expect(now.themeHref).toMatch(/\/themes\/e2e-mine\.css\?v=\d+$/);

    // One variable from the config, applied by `tmuxy config reload`, wins
    // over the theme file; so does an appearance option in the same edit.
    const conf = path.join(CONFIG_DIR, 'tmuxy.conf');
    fs.appendFileSync(
      conf,
      "\nset -g @tmuxy-css-term-background '#0f0e0d'\nset -g @tmuxy-opacity 0.33\n",
    );
    expect(reloadConfig()).toContain('Reloading');
    await waitForCondition(
      page,
      async () => {
        const p = await painted(page);
        return p.termBackground === '#0f0e0d' && p.appOpacity === '0.33';
      },
      10000,
      'the reloaded tmuxy.conf to apply its variable and opacity',
    );

    // custom.css is loaded last and wins over the variable from the config.
    fs.writeFileSync(
      path.join(CONFIG_DIR, 'custom.css'),
      ':root.theme-dark, :root.theme-light { --term-background: #0a0b0c; }\n',
    );
    // Resolved, and painted: the pane's own background follows the variable.
    await waitForCondition(
      page,
      async () => {
        const p = await painted(page);
        return p.termBackground === '#0a0b0c' && p.paneBackground !== paintedWithMine;
      },
      10000,
      'custom.css to win over the config variable',
    );
    now = await painted(page);
    expect(now.themeHref).toContain('/themes/e2e-mine.css');
  });
});
