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

module.exports = { openMenuLabels, menuItemHint, closeMenu };
