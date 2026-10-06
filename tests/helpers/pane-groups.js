/**
 * Pane Group Operations
 *
 * Helpers for interacting with pane groups (tabbed panes).
 */

const { waitForCondition } = require('./browser');

/**
 * Click "Add Pane to Group" via the ⋮ menu on the active pane header
 */
async function clickPaneGroupAdd(page) {
  // The ⋮ of the pane the user is ON. A group's header is divided between its
  // members and each carries its own ⋮, so "the first one in the document" is
  // some other member's menu — it used to be the single shared button, which
  // is why taking the first one worked before.
  const menuBtn =
    (await page.$('.pane-tab.pane-tab-selected .pane-header-menu')) ||
    (await page.$('.pane-active .pane-header-menu')) ||
    (await page.$('.pane-header-menu'));
  if (!menuBtn) throw new Error('Pane header menu button (⋮) not found');
  await menuBtn.click();
  // waitForSelector's `state: 'visible'` is itself the wait for the menu to
  // open, so the beat before it only delayed the first poll.
  const addItem = await page.waitForSelector('[role="menuitem"] >> text=Add Pane to Group', {
    state: 'visible',
    timeout: 5000,
  });
  if (!addItem) throw new Error('"Add Pane to Group" menu item not found');
  const before = await getGroupTabCount(page);
  await addItem.click();
  await waitForCondition(
    page,
    async () => (await getGroupTabCount(page)) > before,
    8000,
    `group tab count to rise above ${before}`,
  );
}

/**
 * Click "Add Pane to Group" via the ⋮ menu (alias for clickPaneGroupAdd)
 */
async function clickGroupTabAdd(page) {
  await clickPaneGroupAdd(page);
}

/**
 * Get the number of tabs in the pane group (0 if not grouped)
 * If there are multiple panes, returns the tab count of the first grouped pane found
 */
async function getGroupTabCount(page) {
  return await page.evaluate(() => {
    // Find pane-tabs-rows that have more than 1 tab (grouped)
    const tabRows = document.querySelectorAll('.pane-tabs');
    for (const row of tabRows) {
      const tabs = row.querySelectorAll('.pane-tab');
      if (tabs.length > 1) {
        return tabs.length; // Return the first grouped pane's tab count
      }
    }
    return 0; // No grouped panes
  });
}

/**
 * Click a group tab by index (0-based)
 */
async function clickGroupTab(page, index) {
  // Use Playwright's native click for better React event handling
  const tabs = await page.$$('.pane-tabs .pane-tab');
  if (index >= tabs.length)
    throw new Error(`Group tab at index ${index} not found (${tabs.length} tabs)`);
  await tabs[index].click();
  // The selected tab moving is what the click is for, and it is readable.
  await waitForCondition(
    page,
    () =>
      page.evaluate((i) => {
        const tabs = document.querySelectorAll('.pane-tabs .pane-tab');
        return tabs[i]?.classList.contains('pane-tab-selected') === true;
      }, index),
    8000,
    `group tab ${index} to become selected`,
  );
}

/**
 * Close a group tab by index (0-based) via right-click context menu
 */
async function clickGroupTabClose(page, index) {
  const tabs = await page.$$('.pane-tabs .pane-tab');
  if (index >= tabs.length)
    throw new Error(`Group tab at index ${index} not found (${tabs.length} tabs)`);
  await tabs[index].click({ button: 'right' });
  // Wait for a visible "Close Pane" menu item
  const closeItem = await page.waitForSelector('[role="menuitem"] >> text=Close Pane', {
    state: 'visible',
    timeout: 5000,
  });
  if (!closeItem) throw new Error('Close Pane menu item not found in context menu');
  const before = await getGroupTabCount(page);
  await closeItem.click();
  await waitForCondition(
    page,
    async () => (await getGroupTabCount(page)) < before,
    8000,
    `group tab count to fall below ${before}`,
  );
}

/**
 * Wait for a specific number of group tabs to appear in a grouped pane
 * For single pane: waits for that pane to have expectedCount tabs
 * For multiple panes: waits for any grouped pane to have expectedCount tabs
 */
async function waitForGroupTabs(page, expectedCount, timeout = 30000) {
  try {
    await page.waitForFunction(
      (count) => {
        const tabRows = document.querySelectorAll('.pane-tabs');
        for (const row of tabRows) {
          const tabs = row.querySelectorAll('.pane-tab');
          if (tabs.length === count) {
            return true;
          }
        }
        return false;
      },
      expectedCount,
      { timeout, polling: 100 },
    );
    return true;
  } catch {
    const actual = await getGroupTabCount(page);
    throw new Error(`Expected ${expectedCount} group tabs, found ${actual} (timeout ${timeout}ms)`);
  }
}

/**
 * Check if any pane header is in grouped mode (has multiple tabs)
 */
async function isHeaderGrouped(page) {
  return await page.evaluate(() => {
    // Check if any pane-tabs-row has more than 1 tab
    const tabRows = document.querySelectorAll('.pane-tabs');
    for (const row of tabRows) {
      if (row.querySelectorAll('.pane-tab').length > 1) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Get info about group tabs (title, active/selected state)
 */
async function getGroupTabInfo(page) {
  return await page.evaluate(() => {
    const tabs = document.querySelectorAll('.pane-tabs .pane-tab');
    return Array.from(tabs).map((tab, index) => ({
      index,
      title: tab.querySelector('.pane-tab-title')?.textContent?.trim() || '',
      active:
        tab.classList.contains('pane-tab-active') || tab.classList.contains('pane-tab-selected'),
      // What the title is actually DRAWN in: the group's member showing is the
      // one wearing the theme's accent, and the parked ones must not be.
      color: getComputedStyle(tab.querySelector('.pane-tab-title')).color,
      // The member's share of the header, and what sits in it: its own ⋮ and
      // ✕ at the right of that share, and a darker ground when it is parked.
      width: tab.getBoundingClientRect().width,
      background: getComputedStyle(tab).backgroundColor,
      buttons: Array.from(tab.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')),
      controlsAfterTitle: (() => {
        const controls = tab.querySelector('.pane-tab-controls');
        if (!controls) return null;
        return (
          controls.getBoundingClientRect().left >=
          tab.querySelector('.pane-tab-title').getBoundingClientRect().right - 1
        );
      })(),
    }));
  });
}

/**
 * The theme's accent, as the browser computes it — the colour the active
 * pane's header title takes.
 */
async function getThemeAccent(page) {
  return await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--theme-accent)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

module.exports = {
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  getThemeAccent,
};
