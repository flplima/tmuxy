/**
 * Pane Group Operations
 *
 * Helpers for interacting with pane groups (tabbed panes).
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');

/**
 * Click "Add Pane to Group" via the ⋮ menu on the active pane header
 */
async function clickPaneGroupAdd(page) {
  const menuBtn = await page.$('.pane-header-menu');
  if (!menuBtn) throw new Error('Pane header menu button (⋮) not found');
  await menuBtn.click();
  await delay(DELAYS.SHORT);
  const addItem = await page.waitForSelector(
    '[role="menuitem"] >> text=Add Pane to Group',
    { state: 'visible', timeout: 5000 },
  );
  if (!addItem) throw new Error('"Add Pane to Group" menu item not found');
  await addItem.click();
  await delay(DELAYS.SYNC);
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
  if (index >= tabs.length) throw new Error(`Group tab at index ${index} not found (${tabs.length} tabs)`);
  await tabs[index].click();
  await delay(DELAYS.SYNC);
}

/**
 * Close a group tab by index (0-based) via right-click context menu
 */
async function clickGroupTabClose(page, index) {
  const tabs = await page.$$('.pane-tabs .pane-tab');
  if (index >= tabs.length) throw new Error(`Group tab at index ${index} not found (${tabs.length} tabs)`);
  await tabs[index].click({ button: 'right' });
  // Wait for a visible "Close Pane" menu item
  const closeItem = await page.waitForSelector(
    '[role="menuitem"] >> text=Close Pane',
    { state: 'visible', timeout: 5000 },
  );
  if (!closeItem) throw new Error('Close Pane menu item not found in context menu');
  await closeItem.click();
  await delay(DELAYS.SYNC);
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
      { timeout, polling: 100 }
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
      active: tab.classList.contains('pane-tab-active') || tab.classList.contains('pane-tab-selected'),
    }));
  });
}

/**
 * Get pane header titles from the UI DOM
 * Returns a map of pane_id -> header title text (stripped of close/add buttons)
 */
async function getUIPaneTitles(page) {
  return await page.evaluate(() => {
    const titles = {};
    const panes = document.querySelectorAll('[data-pane-id]');
    for (const pane of panes) {
      const paneId = pane.getAttribute('data-pane-id');
      // For grouped panes, get the active tab title
      const groupTab = pane.querySelector('.pane-tab-active .pane-tab-title');
      if (groupTab) {
        titles[paneId] = groupTab.textContent?.trim() || '';
        continue;
      }
      // For single panes, get the pane-tab-title span
      const titleEl = pane.querySelector('.pane-tab-title');
      if (titleEl) {
        titles[paneId] = titleEl.textContent?.trim() || '';
      }
    }
    return titles;
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
  getUIPaneTitles,
};
