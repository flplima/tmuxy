/**
 * The open menu, read the way the user sees it: its labels, an item's key
 * hint, and closing it.
 */

const { waitForCondition } = require('./browser');

/** The labels of the menu that is open, waiting for one to be. */
async function openMenuLabels(page) {
  await waitForCondition(
    page,
    () => page.evaluate(() => !!document.querySelector('[role="menu"] [role^="menuitem"]')),
    5000,
    'a menu to open',
  );
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((el) =>
      el.textContent.trim(),
    ),
  );
}

/** The key hint drawn on the open menu's item `label`, or null when it has none. */
function menuItemHint(page, label) {
  return page
    .locator('[role="menuitem"]', { hasText: label })
    .first()
    .locator('.menu-keybinding')
    .textContent({ timeout: 2000 })
    .catch(() => null);
}

/** Escape, and wait for the menu to be gone. */
async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await waitForCondition(
    page,
    async () => (await page.$('[role="menu"]')) === null,
    5000,
    'the menu to close',
  );
}

/** Whether no menu item of any menu is on the page. */
const noMenuOpen = (page) =>
  page.evaluate(() => document.querySelector('[role^="menuitem"]') === null);

/**
 * Open the hamburger menu — once nothing of a previous one is left, since the
 * button toggles and a menu that is still leaving would take the click as a
 * close — and click the entry `labels` names, going through each submenu first.
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

module.exports = { openMenuLabels, menuItemHint, closeMenu, noMenuOpen, clickMenuItem };
