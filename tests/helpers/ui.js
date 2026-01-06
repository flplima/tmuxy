/**
 * UI Helpers
 *
 * Tmuxy UI interaction utilities
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');

// ==================== Keyboard Input ====================

/**
 * Send a key combination (e.g., Ctrl+A)
 */
async function sendKeyCombo(page, ...keys) {
  for (const key of keys.slice(0, -1)) {
    await page.keyboard.down(key);
  }
  await page.keyboard.press(keys[keys.length - 1]);
  for (const key of keys.slice(0, -1).reverse()) {
    await page.keyboard.up(key);
  }
  await delay(DELAYS.SHORT);
}

/**
 * Send tmux prefix key (Ctrl+A for tmuxy)
 */
async function sendTmuxPrefix(page) {
  await sendKeyCombo(page, 'Control', 'a');
}

/**
 * Type a character (handles shift automatically)
 */
async function typeChar(page, char) {
  await page.keyboard.type(char);
  await delay(DELAYS.SHORT);
}

/**
 * Type text in terminal
 */
async function typeInTerminal(page, text) {
  await page.click('body');
  await delay(DELAYS.SHORT);
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(20);
  }
}

/**
 * Press Enter key
 */
async function pressEnter(page) {
  await page.keyboard.press('Enter');
  await delay(DELAYS.SHORT);
}

// ==================== Pane Information ====================

/**
 * Get number of visible panes in UI
 */
async function getUIPaneCount(page) {
  return await page.evaluate(() => {
    const panes = document.querySelectorAll('[data-pane-id]');
    if (panes.length > 0) {
      const uniqueIds = new Set();
      for (const pane of panes) {
        uniqueIds.add(pane.getAttribute('data-pane-id'));
      }
      return uniqueIds.size;
    }
    return document.querySelectorAll('[role="log"]').length;
  });
}

/**
 * Get UI pane details
 */
async function getUIPaneInfo(page) {
  return await page.evaluate(() => {
    const panes = document.querySelectorAll('[data-pane-id]');
    if (panes.length === 0) {
      const logs = document.querySelectorAll('[role="log"]');
      return Array.from(logs).map((log, index) => {
        const rect = log.getBoundingClientRect();
        return {
          index,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
      });
    }

    const seenIds = new Set();
    const uniquePanes = [];

    for (const pane of panes) {
      const paneId = pane.getAttribute('data-pane-id');
      if (!seenIds.has(paneId)) {
        seenIds.add(paneId);
        const rect = pane.getBoundingClientRect();
        uniquePanes.push({
          id: paneId,
          index: uniquePanes.length,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
    }
    return uniquePanes;
  });
}

/**
 * Get terminal text content
 */
async function getTerminalText(page) {
  return await page.evaluate(() => {
    const logs = document.querySelectorAll('[role="log"]');
    return Array.from(logs).map(l => l.textContent || '').join('\n');
  });
}

// ==================== UI Interactions ====================

/**
 * Click on a pane by index
 */
async function clickPane(page, paneIndex) {
  const panes = await getUIPaneInfo(page);
  if (paneIndex >= panes.length) {
    throw new Error(`Pane index ${paneIndex} out of range (${panes.length} panes)`);
  }
  const pane = panes[paneIndex];
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await delay(DELAYS.MEDIUM);
}

/**
 * Click a button by text
 */
async function clickButton(page, buttonText) {
  const clicked = await page.evaluate((text) => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes(text)) {
        btn.click();
        return true;
      }
    }
    return false;
  }, buttonText);

  if (!clicked) throw new Error(`Button "${buttonText}" not found`);
  await delay(DELAYS.MEDIUM);
}

/**
 * Click a menu item
 */
async function clickMenuItem(page, menuText, itemText) {
  // Open menu
  await page.evaluate((text) => {
    const elements = document.querySelectorAll('button, [role="button"], .menu-trigger');
    for (const el of elements) {
      if (el.textContent.includes(text)) {
        el.click();
        return true;
      }
    }
    return false;
  }, menuText);

  await delay(DELAYS.MEDIUM);

  // Click item
  const clicked = await page.evaluate((text) => {
    const items = document.querySelectorAll('[role="menuitem"], .menu-item, button');
    for (const item of items) {
      if (item.textContent.includes(text)) {
        item.click();
        return true;
      }
    }
    return false;
  }, itemText);

  if (!clicked) throw new Error(`Menu item "${itemText}" not found`);
  await delay(DELAYS.MEDIUM);
}

/**
 * Wait for pane count to change
 */
async function waitForPaneCount(page, expectedCount, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getUIPaneCount(page);
    if (count === expectedCount) return true;
    await delay(DELAYS.MEDIUM);
  }
  throw new Error(`Pane count did not reach ${expectedCount} within ${timeout}ms`);
}

// ==================== Split Operations ====================

/**
 * Split pane via keyboard
 */
async function splitPaneKeyboard(page, direction = 'horizontal') {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  const key = direction === 'horizontal' ? '"' : '%';
  await typeChar(page, key);
  await delay(DELAYS.EXTRA_LONG);
}

/**
 * Split pane via UI menu
 */
async function splitPaneUI(page, direction = 'horizontal') {
  try {
    // Try to find and click the split button directly
    const splitBtnSelector = direction === 'horizontal'
      ? '[title*="split" i][title*="horizontal" i], [aria-label*="split" i][aria-label*="horizontal" i], .split-horizontal'
      : '[title*="split" i][title*="vertical" i], [aria-label*="split" i][aria-label*="vertical" i], .split-vertical';

    const directButton = await page.$(splitBtnSelector);
    if (directButton) {
      await directButton.click();
      await delay(DELAYS.EXTRA_LONG);
      return;
    }

    // Fallback to menu
    const menuText = direction === 'horizontal' ? 'Split Horizontal' : 'Split Vertical';
    await clickMenuItem(page, 'tmux', menuText);
    await delay(DELAYS.EXTRA_LONG);
  } catch {
    // Try pane context menu
    const panes = await getUIPaneInfo(page);
    if (panes.length > 0) {
      await page.mouse.click(panes[0].x + 10, panes[0].y + 10, { button: 'right' });
      await delay(DELAYS.MEDIUM);
      const menuText = direction === 'horizontal' ? 'Split Horizontal' : 'Split Vertical';
      await clickButton(page, menuText);
    }
  }
}

// ==================== Navigation Operations ====================

/**
 * Navigate to pane via keyboard
 */
async function navigatePaneKeyboard(page, direction) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);

  const keyMap = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    next: 'o',
  };

  const key = keyMap[direction] || direction;
  await page.keyboard.press(key);
  await delay(DELAYS.LONG);
}

// ==================== Swap Operations ====================

/**
 * Swap pane via keyboard
 */
async function swapPaneKeyboard(page, direction = 'down') {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  const key = direction === 'down' ? '}' : '{';
  await typeChar(page, key);
  await delay(DELAYS.EXTRA_LONG);
}

// ==================== Zoom Operations ====================

/**
 * Toggle pane zoom via keyboard
 */
async function toggleZoomKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press('z');
  await delay(DELAYS.EXTRA_LONG);
}

// ==================== Window Operations ====================

/**
 * Create new window via keyboard
 */
async function createWindowKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press('c');
  await delay(DELAYS.EXTRA_LONG);
}

/**
 * Switch to next window via keyboard
 */
async function nextWindowKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press('n');
  await delay(DELAYS.LONG);
}

/**
 * Switch to previous window via keyboard
 */
async function prevWindowKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press('p');
  await delay(DELAYS.LONG);
}

/**
 * Switch to window by number via keyboard
 */
async function selectWindowKeyboard(page, number) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press(String(number));
  await delay(DELAYS.LONG);
}

// ==================== Kill Operations ====================

/**
 * Kill pane via keyboard (with confirmation)
 */
async function killPaneKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press('x');
  await delay(DELAYS.LONG);
  await page.keyboard.press('y'); // Confirm
  await delay(DELAYS.EXTRA_LONG);
}

// ==================== Layout Operations ====================

/**
 * Cycle layout via keyboard
 */
async function cycleLayoutKeyboard(page) {
  await sendTmuxPrefix(page);
  await delay(DELAYS.SHORT);
  await page.keyboard.press(' ');
  await delay(DELAYS.EXTRA_LONG);
}

module.exports = {
  // Keyboard
  sendKeyCombo,
  sendTmuxPrefix,
  typeChar,
  typeInTerminal,
  pressEnter,
  // Pane info
  getUIPaneCount,
  getUIPaneInfo,
  getTerminalText,
  // UI interactions
  clickPane,
  clickButton,
  clickMenuItem,
  waitForPaneCount,
  // Split
  splitPaneKeyboard,
  splitPaneUI,
  // Navigate
  navigatePaneKeyboard,
  // Swap
  swapPaneKeyboard,
  // Zoom
  toggleZoomKeyboard,
  // Window
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  // Kill
  killPaneKeyboard,
  // Layout
  cycleLayoutKeyboard,
};
