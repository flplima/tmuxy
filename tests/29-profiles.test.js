/**
 * Profiles E2E Tests
 *
 * View > Profiles, the way a user drives it: a profile file in the config
 * dir is listed, picked, and repaints the page without a reload; Duplicate,
 * Rename, Delete and New go through their dialog; the file and the
 * remembered session map follow every step; back on the Default Profile the
 * page is painted as it was. A server with scratch config, data and state
 * dirs of its own is what makes the files safe to write.
 */

const fs = require('fs');
const path = require('path');
const {
  describeE2E,
  openSession,
  waitForCondition,
  noMenuOpen,
  clickMenuItem,
} = require('./helpers');
const {
  CONFIG_URL,
  CONFIG_DIR,
  DATA_DIR,
  STATE_DIR,
  startConfigServer,
  unsetConfigVariable,
} = require('./helpers/config-server');

const DEFAULT = 'Default Profile';

/** The terminal background the page resolves. */
const termBackground = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-background').trim(),
  );

/** View > Profiles' items, each with whether it is checked or greyed out; closed again after. */
async function profileItems(page) {
  await clickMenuItem(page, ['View', 'Profiles']);
  await page.locator('[role^="menuitem"]', { hasText: 'New Profile' }).waitFor({ timeout: 5000 });
  const items = await page.evaluate(() => {
    const menus = document.querySelectorAll('[role="menu"]');
    return [...menus[menus.length - 1].querySelectorAll('[role^="menuitem"]')].map((el) => ({
      text: el.textContent.trim(),
      checked: el.getAttribute('aria-checked') === 'true',
      disabled: el.getAttribute('aria-disabled') === 'true',
    }));
  });
  // One Escape per level: Profiles, View, the app menu.
  for (let level = 0; level < 3; level++) await page.keyboard.press('Escape');
  await waitForCondition(page, () => noMenuOpen(page), 5000, 'the menu to close');
  return items;
}

/** The checked profile, once the menu lists `expected` checked. */
async function waitForActive(page, expected) {
  await waitForCondition(
    page,
    async () => (await profileItems(page)).some((i) => i.checked && i.text === expected),
    10000,
    async () =>
      `View > Profiles to check ${expected}; it lists ${JSON.stringify(await profileItems(page))}`,
  );
}

/** The dialog's button `label`, which must be on screen to be clicked. */
async function clickDialogButton(page, label) {
  const button = page.locator('.profile-dialog button', { hasText: label });
  await button.waitFor({ state: 'visible', timeout: 5000 });
  const box = await button.boundingBox();
  expect(box && box.width > 0 && box.height > 0).toBe(true);
  await button.click();
  await page.locator('.profile-dialog').waitFor({ state: 'detached', timeout: 5000 });
}

const profileFile = (name) => path.join(CONFIG_DIR, 'profiles', `${name}.json`);

/** Which profile each session uses, as the state file remembers it. */
const sessionMap = () => {
  const file = path.join(STATE_DIR, 'tmuxy.state.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')).session_profiles ?? {};
};

/** Nord's dark terminal background, read from the theme file the server ships. */
const nordBackground = () =>
  fs
    .readFileSync(path.join(DATA_DIR, 'themes', 'nord.css'), 'utf8')
    .match(/--term-background:\s*(#[0-9a-fA-F]+);/)[1]
    .toLowerCase();

describeE2E('Scenario 32: Terminal profiles from the View menu', {}, (ctx) => {
  let stopServer = () => {};

  afterEach(async () => {
    await stopServer();
    stopServer = () => {};
  }, ctx.hookTimeout);

  test('a profile is picked, copied, renamed, deleted and made from View > Profiles, live and remembered', async () => {
    unsetConfigVariable();
    stopServer = await startConfigServer();
    fs.mkdirSync(path.join(CONFIG_DIR, 'profiles'), { recursive: true });
    fs.writeFileSync(profileFile('Night'), JSON.stringify({ theme: 'nord', themeMode: 'dark' }));

    const page = ctx.page;
    const session = ctx.session.name;
    await openSession(page, session, CONFIG_URL);
    await page.waitForSelector('.pane-layout-item.pane-active', { timeout: 15000 });
    const before = await termBackground(page);
    const nord = nordBackground();
    expect(before.toLowerCase()).not.toBe(nord);

    // Out of the box: the Default Profile, checked, with nothing to rename
    // or delete, and the file in the config dir listed beside it.
    await waitForActive(page, DEFAULT);
    let items = await profileItems(page);
    expect(items.map((i) => i.text)).toEqual(
      expect.arrayContaining([DEFAULT, 'Night', 'New Profile…', 'Duplicate Profile…']),
    );
    expect(items.find((i) => i.text === 'Rename Profile…').disabled).toBe(true);
    expect(items.find((i) => i.text === 'Delete Profile…').disabled).toBe(true);
    expect(sessionMap()).toEqual({});

    // Picked: the page repaints with the profile's theme, no reload, and the
    // session's choice is remembered.
    await clickMenuItem(page, ['View', 'Profiles', 'Night']);
    await waitForCondition(
      page,
      async () => (await termBackground(page)).toLowerCase() === nord,
      10000,
      async () => `Night's theme to be painted; the page shows ${await termBackground(page)}`,
    );
    await waitForActive(page, 'Night');
    expect(sessionMap()).toEqual({ [session]: 'Night' });

    // Duplicate: the dialog offers a free name; the copy holds the same
    // settings and becomes the session's.
    await clickMenuItem(page, ['View', 'Profiles', 'Duplicate Profile…']);
    const input = page.locator('.profile-dialog input');
    await input.waitFor({ state: 'visible', timeout: 5000 });
    expect(await input.inputValue()).toBe('Night copy');
    await clickDialogButton(page, 'Duplicate');
    await waitForActive(page, 'Night copy');
    expect(JSON.parse(fs.readFileSync(profileFile('Night copy'), 'utf8'))).toEqual({
      theme: 'nord',
      themeMode: 'dark',
    });

    // Rename: a taken name is refused in the dialog before anything is sent.
    await clickMenuItem(page, ['View', 'Profiles', 'Rename Profile…']);
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill('Night');
    await page
      .locator('.profile-dialog .app-menu-dialog-problem', { hasText: 'already exists' })
      .waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator('.profile-dialog button', { hasText: 'Rename' }).isDisabled()).toBe(
      true,
    );
    await input.fill('Evening');
    await clickDialogButton(page, 'Rename');
    await waitForActive(page, 'Evening');
    expect(fs.existsSync(profileFile('Evening'))).toBe(true);
    expect(fs.existsSync(profileFile('Night copy'))).toBe(false);
    expect(sessionMap()).toEqual({ [session]: 'Evening' });
    expect((await termBackground(page)).toLowerCase()).toBe(nord);

    // Delete: confirmed, the file goes, and the session is back on the
    // Default Profile, painted as it was before any profile.
    await clickMenuItem(page, ['View', 'Profiles', 'Delete Profile…']);
    await clickDialogButton(page, 'Delete');
    await waitForActive(page, DEFAULT);
    expect(fs.existsSync(profileFile('Evening'))).toBe(false);
    expect(sessionMap()).toEqual({});
    await waitForCondition(
      page,
      async () => (await termBackground(page)) === before,
      10000,
      async () =>
        `the global theme to be painted again; the page shows ${await termBackground(page)}`,
    );

    // New: an empty profile, which changes nothing, made and used.
    await clickMenuItem(page, ['View', 'Profiles', 'New Profile…']);
    await input.waitFor({ state: 'visible', timeout: 5000 });
    expect(await input.inputValue()).toBe('Profile');
    await clickDialogButton(page, 'Create');
    await waitForActive(page, 'Profile');
    expect(JSON.parse(fs.readFileSync(profileFile('Profile'), 'utf8'))).toEqual({});
    expect(await termBackground(page)).toBe(before);

    // And back to the default from the menu.
    await clickMenuItem(page, ['View', 'Profiles', DEFAULT]);
    await waitForActive(page, DEFAULT);
    expect(sessionMap()).toEqual({});
  });
});
