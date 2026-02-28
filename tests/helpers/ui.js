/**
 * UI Helpers
 *
 * Tmuxy UI interaction utilities
 *
 * This module contains two types of helpers:
 *
 * 1. **Core helpers** - Used throughout tests:
 *    - sendKeyCombo, sendTmuxPrefix, typeInTerminal, pressEnter
 *    - getTerminalText, waitForTerminalText, runCommand
 *    - getUIPaneCount, getUIPaneInfo
 *
 * 2. **Keyboard operation helpers** - For testing keyboard-driven UI operations:
 *    - splitPaneKeyboard, navigatePaneKeyboard, swapPaneKeyboard
 *    - toggleZoomKeyboard, createWindowKeyboard, nextWindowKeyboard
 *    - killPaneKeyboard, cycleLayoutKeyboard, etc.
 *    These test that keyboard shortcuts work through the UI layer.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');

// ==================== Focus Helper ====================

/**
 * Focus the terminal element, retrying if it's been detached by a React re-render.
 */
async function focusTerminal(page) {
  try {
    await page.click('[role="log"]', { timeout: 2000 });
  } catch {
    // Terminal may have been re-rendered; try again after a brief wait
    await delay(100);
    try {
      await page.click('[role="log"]', { timeout: 2000 });
    } catch {
      await page.click('body').catch(() => {});
    }
  }
}

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
 * Read the tmux prefix key from the browser's XState context.
 * Returns { modifier, key } e.g. { modifier: 'Control', key: 'b' } for C-b.
 * Falls back to Ctrl+B (tmux default) if not available.
 */
async function getPrefixKey(page) {
  const prefixStr = await page.evaluate(() => {
    return window.app?.getSnapshot()?.context?.keybindings?.prefix_key;
  });
  // Parse "C-b" or "C-a" style prefix key strings
  if (prefixStr && prefixStr.startsWith('C-')) {
    return { modifier: 'Control', key: prefixStr.slice(2) };
  }
  // Default to Ctrl+B (tmux default)
  return { modifier: 'Control', key: 'b' };
}

/**
 * Send tmux prefix key (dynamically read from XState keybindings)
 * Includes a longer delay to allow tmux to enter prefix mode
 */
async function sendTmuxPrefix(page) {
  await focusTerminal(page);
  await delay(DELAYS.MEDIUM);

  // Read the actual prefix key from the browser's XState context
  const prefix = await getPrefixKey(page);
  await page.keyboard.down(prefix.modifier);
  await delay(50);
  await page.keyboard.press(prefix.key);
  await delay(50);
  await page.keyboard.up(prefix.modifier);

  // Use PREFIX delay to give tmux time to enter prefix mode
  await delay(DELAYS.PREFIX);
}

/**
 * Send a tmux prefix command (prefix key followed by another key)
 * This is the recommended way to send tmux keyboard shortcuts.
 * Handles proper timing between prefix and command key.
 *
 * @param {Page} page - Playwright page
 * @param {string} key - The key to send after prefix (e.g., '[', 'c', 'z')
 * @param {Object} options - Options for key sending
 * @param {boolean} options.shift - Whether to hold shift while pressing key
 */
async function sendPrefixCommand(page, key, options = {}) {
  const { shift = false } = options;

  await focusTerminal(page);
  await delay(DELAYS.MEDIUM);

  // Read the actual prefix key from the browser's XState context
  const prefix = await getPrefixKey(page);
  await page.keyboard.down(prefix.modifier);
  await delay(50);
  await page.keyboard.press(prefix.key);
  await delay(50);
  await page.keyboard.up(prefix.modifier);

  // Wait for tmux to enter prefix mode - this is critical
  // The key needs to travel: browser -> SSE/HTTP -> server -> tmux
  await delay(DELAYS.PREFIX);

  // Send the command key
  if (shift) {
    await page.keyboard.down('Shift');
    await delay(50);
  }
  await page.keyboard.press(key);
  if (shift) {
    await delay(50);
    await page.keyboard.up('Shift');
  }

  // Wait for command to be processed
  await delay(DELAYS.LONG);
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
  // Click the terminal element directly for reliable focus (not body)
  const terminal = await page.$('[role="log"]');
  if (terminal) {
    await terminal.click();
  } else {
    await page.click('body');
  }
  await delay(DELAYS.MEDIUM);
  // Per-character typing with delay — the HttpAdapter batches literal
  // characters into a single send-keys -l command and serializes HTTP
  // requests, preventing transposition.
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(30);
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

/**
 * Wait for specific text to appear in terminal.
 * Uses Node-side polling with page.evaluate for reliable cross-environment behavior.
 * (Browser-side waitForFunction can miss transient DOM states on CI.)
 */
async function waitForTerminalText(page, text, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((searchText) => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map(l => l.textContent || '').join('\n');
      return content.includes(searchText);
    }, text);
    if (found) return await getTerminalText(page);
    await delay(100);
  }
  const content = await getTerminalText(page);
  throw new Error(`Timeout waiting for "${text}" in terminal (${timeout}ms). Content (${content.length} chars): "${content.slice(0, 200)}"`);
}

/**
 * Get terminal text content for a specific pane by ID
 */
async function getPaneText(page, paneId) {
  return await page.evaluate((id) => {
    const pane = document.querySelector(`[data-pane-id="${id}"]`);
    if (!pane) return null;
    const terminal = pane.querySelector('.terminal-content, [role="log"]');
    return terminal ? terminal.textContent || '' : null;
  }, paneId);
}

/**
 * Check if UI contains a specific text string
 */
async function uiContainsText(page, text) {
  const content = await getTerminalText(page);
  return content.includes(text);
}

/**
 * Run a command in terminal and wait for expected output
 * This is a common pattern extracted for reuse
 */
async function runCommand(page, command, expectedOutput, timeout = 10000) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  return await waitForTerminalText(page, expectedOutput, timeout);
}

/**
 * Run a command and return terminal text after a delay (for commands without specific output)
 */
async function runCommandWithDelay(page, command, delayMs = 1000) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  await delay(delayMs);
  return await getTerminalText(page);
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
 * Wait for pane count to change (non-throwing)
 */
async function waitForPaneCount(page, expectedCount, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getUIPaneCount(page);
    if (count === expectedCount) return true;
    await delay(DELAYS.MEDIUM);
  }
  // Log warning instead of throwing - UI sync can be slow
  const actualCount = await getUIPaneCount(page);
  // Expected pane count not reached within timeout
  return false;
}

// ==================== Split Operations ====================

/**
 * Split pane via keyboard
 */
async function splitPaneKeyboard(page, direction = 'horizontal') {
  // Use sendPrefixCommand for reliable timing
  // " = horizontal split (Shift+'), % = vertical split (Shift+5)
  if (direction === 'horizontal') {
    await sendPrefixCommand(page, "'", { shift: true });
  } else {
    await sendPrefixCommand(page, '5', { shift: true });
  }
  // Reduced delay - callers should use waitForPaneCount for reliable sync
  await delay(DELAYS.LONG);
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
      await delay(DELAYS.LONG);
      return;
    }

    // Fallback to menu
    const menuText = direction === 'horizontal' ? 'Split Horizontal' : 'Split Vertical';
    await clickMenuItem(page, 'tmux', menuText);
    await delay(DELAYS.LONG);
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
 * Navigate to pane via keyboard using root bindings (Ctrl+arrow).
 * The .tmuxy.conf binds Ctrl+arrow keys as root bindings (no prefix needed)
 * for pane navigation: C-Up=select-pane -U, C-Down=select-pane -D, etc.
 */
async function navigatePaneKeyboard(page, direction) {
  const keyMap = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };

  const key = keyMap[direction];
  if (key) {
    // Use Ctrl+arrow root binding (no prefix needed)
    await sendKeyCombo(page, 'Control', key);
    await delay(DELAYS.LONG);
  } else if (direction === 'next') {
    await sendPrefixCommand(page, 'o');
  }
}

// ==================== Swap Operations ====================

/**
 * Swap pane via keyboard
 */
async function swapPaneKeyboard(page, direction = 'down') {
  // } = swap down (Shift+]), { = swap up (Shift+[)
  if (direction === 'down') {
    await sendPrefixCommand(page, ']', { shift: true });
  } else {
    await sendPrefixCommand(page, '[', { shift: true });
  }
  await delay(DELAYS.LONG);
}

// ==================== Zoom Operations ====================

/**
 * Toggle pane zoom via keyboard
 */
async function toggleZoomKeyboard(page) {
  await sendPrefixCommand(page, 'z');
  await delay(DELAYS.LONG);
}

// ==================== Window Operations ====================

/**
 * Create new window via the XState SEND_COMMAND event.
 * Uses the 'new-window' command which the server intercepts and converts
 * to split-window + break-pane (since new-window crashes tmux 3.5a control mode).
 */
async function createWindowKeyboard(page) {
  await page.evaluate(async () => {
    await window._adapter.invoke('run_tmux_command', { command: 'new-window' });
  });
  await delay(DELAYS.SYNC);
}

/**
 * Switch to next window via keyboard
 */
async function nextWindowKeyboard(page) {
  await sendPrefixCommand(page, 'n');
}

/**
 * Switch to previous window via keyboard
 */
async function prevWindowKeyboard(page) {
  await sendPrefixCommand(page, 'p');
}

/**
 * Switch to window by number via tmux command.
 * The .tmuxy.conf binds Alt+number as root bindings (no prefix needed)
 * for window selection, but the keyboard actor may not route Alt reliably.
 * Using the command prompt is more reliable.
 */
async function selectWindowKeyboard(page, number) {
  await tmuxCommandKeyboard(page, `select-window -t :${number}`);
}

// ==================== Kill Operations ====================

/**
 * Kill pane via tmux command prompt.
 * Note: prefix+x uses confirm-before which shows a prompt in the tmux status
 * line. The keyboard actor routes 'y' via send-keys to the pane, not to the
 * confirm prompt. So we use the command prompt instead.
 */
async function killPaneKeyboard(page) {
  await tmuxCommandKeyboard(page, 'kill-pane');
  await delay(DELAYS.SYNC);
}

// ==================== Layout Operations ====================

/**
 * Cycle layout via keyboard
 */
async function cycleLayoutKeyboard(page) {
  await sendPrefixCommand(page, ' ');
  await delay(DELAYS.LONG);
}

// ==================== Copy Mode Operations ====================

/**
 * Enter copy mode via keyboard (Ctrl+A [)
 */
async function enterCopyModeKeyboard(page) {
  await sendPrefixCommand(page, '[');
}

/**
 * Exit copy mode via keyboard (q in vi mode)
 */
async function exitCopyModeKeyboard(page) {
  await page.keyboard.press('q');
  await delay(DELAYS.LONG);
}

/**
 * Scroll up in pane to enter copy mode
 */
async function scrollPaneUp(page, paneId) {
  await page.evaluate((id) => {
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${id}"]`);
    if (pane) {
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
    }
  }, paneId);
  await delay(DELAYS.LONG);
}

/**
 * Scroll down in pane
 */
async function scrollPaneDown(page, paneId) {
  await page.evaluate((id) => {
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${id}"]`);
    if (pane) {
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
    }
  }, paneId);
  await delay(DELAYS.LONG);
}

/**
 * Check if pane header shows copy mode
 */
async function isPaneCopyModeVisible(page, paneId) {
  return await page.evaluate((id) => {
    const pane = document.querySelector(`[data-pane-id="${id}"]`);
    if (!pane) return false;
    const header = pane.querySelector('.pane-tab, .pane-title');
    return header && header.textContent.includes('[COPY MODE]');
  }, paneId);
}

/**
 * Check if pane has copy mode styling (green header)
 */
async function hasCopyModeStyling(page, paneId) {
  return await page.evaluate((id) => {
    const pane = document.querySelector(`[data-pane-id="${id}"]`);
    if (!pane) return false;
    const header = pane.querySelector('.pane-tab');
    return header && header.classList.contains('pane-tab-copy-mode');
  }, paneId);
}

/**
 * Get first visible pane ID
 */
async function getFirstPaneId(page) {
  return await page.evaluate(() => {
    const pane = document.querySelector('.pane-wrapper[data-pane-id]');
    return pane ? pane.getAttribute('data-pane-id') : null;
  });
}

// ==================== Pane Group Operations ====================

/**
 * Click the "add to group" button on the active pane header
 */
async function clickPaneGroupAdd(page) {
  // Use Playwright's native click for better React event handling
  const button = await page.$('.pane-tab-add');
  if (!button) throw new Error('Pane group add button not found');
  await button.click();
  await delay(DELAYS.SYNC);
}

/**
 * Click the "+" button in a grouped pane's tab bar
 */
async function clickGroupTabAdd(page) {
  // Use Playwright's native click for better React event handling
  const button = await page.$('.pane-tab-add');
  if (!button) throw new Error('Group tab add button not found');
  await button.click();
  await delay(DELAYS.SYNC);
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
  await delay(DELAYS.SHORT);
  // Click "Close Pane" from the context menu
  const menuItems = await page.$$('[role="menuitem"]');
  let closeItem = null;
  for (const item of menuItems) {
    const text = await item.textContent();
    if (text.includes('Close Pane')) {
      closeItem = item;
      break;
    }
  }
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

// ==================== Tmux Command Line ====================

/**
 * Run a tmux command via the tmux command prompt (prefix+: then type command + Enter)
 */
async function tmuxCommandKeyboard(page, cmd) {
  await sendPrefixCommand(page, ':');
  await delay(DELAYS.MEDIUM);
  // Type command character by character — adapter batching preserves order
  for (const char of cmd) {
    await page.keyboard.type(char);
    await delay(10);
  }
  await page.keyboard.press('Enter');
  await delay(DELAYS.LONG);
}

// ==================== Additional Window Operations ====================

/**
 * Switch to last visited window via keyboard (prefix+l)
 */
async function lastWindowKeyboard(page) {
  await sendPrefixCommand(page, 'l');
}

/**
 * Rename current window via tmux command prompt.
 * Note: prefix+, opens a rename prompt in the tmux status line. The keyboard
 * actor routes keystrokes via send-keys to the pane, not to the rename prompt.
 * So we use the command prompt instead.
 */
async function renameWindowKeyboard(page, name) {
  await tmuxCommandKeyboard(page, `rename-window "${name}"`);
}

/**
 * Kill current window via tmux command prompt.
 * Note: prefix+& uses confirm-before which shows a prompt in the tmux status
 * line. The keyboard actor routes 'y' via send-keys to the pane, not to the
 * confirm prompt. So we use the command prompt instead.
 */
async function killWindowKeyboard(page) {
  await tmuxCommandKeyboard(page, 'kill-window');
  await delay(DELAYS.SYNC);
}

// ==================== Layout Operations (Extended) ====================

/**
 * Select a specific layout by name via tmux command
 */
async function selectLayoutKeyboard(page, name) {
  await tmuxCommandKeyboard(page, `select-layout ${name}`);
}

// ==================== Resize Operations ====================

/**
 * Resize pane via tmux command
 * @param {string} direction - 'U', 'D', 'L', 'R'
 * @param {number} amount - Number of cells to resize
 */
async function resizePaneKeyboard(page, direction, amount = 5) {
  await tmuxCommandKeyboard(page, `resize-pane -${direction} ${amount}`);
}

// ==================== Copy Mode Operations (Extended) ====================

/**
 * Paste from tmux buffer via keyboard (prefix+])
 */
async function pasteBufferKeyboard(page) {
  await sendPrefixCommand(page, ']');
  await delay(DELAYS.LONG);
}

/**
 * Search forward in copy mode via tmux command.
 * Note: The browser's client-side copy mode intercepts keyboard events and
 * doesn't support '/' search. So we send search commands through tmux.
 */
async function copyModeSearchForwardKeyboard(page, pattern) {
  await tmuxCommandKeyboard(page, `send-keys -X search-forward "${pattern}"`);
}

/**
 * Search again in copy mode via tmux command
 */
async function copyModeSearchAgainKeyboard(page) {
  await tmuxCommandKeyboard(page, 'send-keys -X search-again');
}

/**
 * Search reverse in copy mode via tmux command
 */
async function copyModeSearchReverseKeyboard(page) {
  await tmuxCommandKeyboard(page, 'send-keys -X search-reverse');
}

/**
 * Begin selection in copy mode via tmux command
 */
async function copyModeBeginSelectionKeyboard(page) {
  await tmuxCommandKeyboard(page, 'send-keys -X begin-selection');
}

/**
 * Copy selection in copy mode via tmux command
 */
async function copyModeCopySelectionKeyboard(page) {
  await tmuxCommandKeyboard(page, 'send-keys -X copy-selection-and-cancel');
  await delay(DELAYS.SYNC);
}

/**
 * Move cursor in copy mode via tmux command.
 * @param {string} direction - 'left', 'right', 'up', 'down'
 * @param {number} count - Number of times to move
 */
async function copyModeMoveKeyboard(page, direction, count = 1) {
  const cmdMap = {
    left: 'cursor-left',
    right: 'cursor-right',
    up: 'cursor-up',
    down: 'cursor-down',
  };
  const cmd = cmdMap[direction] || direction;
  for (let i = 0; i < count; i++) {
    await tmuxCommandKeyboard(page, `send-keys -X ${cmd}`);
  }
}

/**
 * Paste text into the terminal via a synthetic ClipboardEvent
 */
async function pasteText(page, text) {
  await page.evaluate((t) => {
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    event.clipboardData.setData('text/plain', t);
    window.dispatchEvent(event);
  }, text);
  await delay(DELAYS.LONG);
}

module.exports = {
  // Keyboard
  sendKeyCombo,
  sendTmuxPrefix,
  sendPrefixCommand,
  typeChar,
  typeInTerminal,
  pressEnter,
  pasteText,
  // Pane info
  getUIPaneCount,
  getUIPaneInfo,
  getTerminalText,
  waitForTerminalText,
  getPaneText,
  uiContainsText,
  runCommand,
  runCommandWithDelay,
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
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
  // Kill
  killPaneKeyboard,
  // Layout
  cycleLayoutKeyboard,
  selectLayoutKeyboard,
  // Tmux command line
  tmuxCommandKeyboard,
  // Resize
  resizePaneKeyboard,
  // Copy mode
  enterCopyModeKeyboard,
  exitCopyModeKeyboard,
  pasteBufferKeyboard,
  copyModeSearchForwardKeyboard,
  copyModeSearchAgainKeyboard,
  copyModeSearchReverseKeyboard,
  copyModeBeginSelectionKeyboard,
  copyModeCopySelectionKeyboard,
  copyModeMoveKeyboard,
  scrollPaneUp,
  scrollPaneDown,
  isPaneCopyModeVisible,
  hasCopyModeStyling,
  getFirstPaneId,
  // Pane groups
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
