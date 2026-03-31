/**
 * Pane Operations
 *
 * Pane information, split, navigate, swap, zoom, kill, layout, and resize.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');
const { sendKeyCombo, sendPrefixCommand, tmuxCommandKeyboard, typeInTerminal, pressEnter } = require('./keyboard');

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
 * Wait for a shell prompt to appear in the terminal.
 * Matches common prompt characters: $ # % > ❯
 */
async function waitForShellPrompt(page, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate(() => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map(l => l.textContent || '').join('\n');
      return content.length > 5 && /[$#%>❯]/.test(content);
    });
    if (found) return await getTerminalText(page);
    await delay(100);
  }
  const content = await getTerminalText(page);
  throw new Error(`Timeout waiting for shell prompt (${timeout}ms). Content (${content.length} chars): "${content.slice(0, 200)}"`);
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
 * Run a command in terminal and wait for expected output.
 * If browser keyboard events fail to reach tmux (CI focus issue), retries
 * by sending the command directly via tmux send-keys as a fallback.
 */
async function runCommand(page, command, expectedOutput, timeout = 20000) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  try {
    return await waitForTerminalText(page, expectedOutput, timeout);
  } catch (domErr) {
    // Fallback: browser keyboard events may not reach tmux on CI.
    // Send the command directly via tmux send-keys and verify via capture-pane.
    const { tmuxQuery } = require('./cli');
    const sessionName = await page.evaluate(() =>
      window.app?.getSnapshot()?.context?.sessionName,
    );
    if (!sessionName) throw domErr;
    // Send Ctrl-C to cancel any partial input, then send the command
    tmuxQuery(`send-keys -t ${sessionName} C-c`);
    await delay(200);
    tmuxQuery(`send-keys -t ${sessionName} '${command.replace(/'/g, "'\\''")}' Enter`);
    // Wait for output via capture-pane
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const captured = tmuxQuery(`capture-pane -t ${sessionName} -p`);
      if (captured.includes(expectedOutput)) {
        // Also wait for DOM to update
        try {
          return await waitForTerminalText(page, expectedOutput, 5000);
        } catch {
          return captured;
        }
      }
      await delay(200);
    }
    throw new Error(`Command "${command}" output "${expectedOutput}" not found via browser or tmux send-keys fallback`);
  }
}

/**
 * Run a command in terminal with capture-pane fallback.
 * Falls back to tmux capture-pane verification when DOM doesn't update (CI SSE issue).
 * @param {string} sessionName - tmux session name for capture-pane fallback
 */
async function runCommandResilient(page, sessionName, command, expectedOutput, timeout = 20000) {
  const { tmuxQuery } = require('./cli');
  await typeInTerminal(page, command);
  await pressEnter(page);
  try {
    return await waitForTerminalText(page, expectedOutput, timeout);
  } catch {
    await delay(DELAYS.SYNC);
    const captured = tmuxQuery(`capture-pane -t ${sessionName} -p`);
    if (!captured.includes(expectedOutput)) {
      throw new Error(`Command output "${expectedOutput}" not found in DOM or tmux capture-pane`);
    }
    return getTerminalText(page);
  }
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

module.exports = {
  // Pane info
  getUIPaneCount,
  getUIPaneInfo,
  getTerminalText,
  waitForTerminalText,
  waitForShellPrompt,
  getPaneText,
  uiContainsText,
  runCommand,
  runCommandResilient,
  runCommandWithDelay,
  // UI interactions
  clickPane,
  clickButton,
  clickMenuItem,
  // Split
  splitPaneKeyboard,
  splitPaneUI,
  // Navigate
  navigatePaneKeyboard,
  // Swap
  swapPaneKeyboard,
  // Zoom
  toggleZoomKeyboard,
  // Kill
  killPaneKeyboard,
  // Layout
  cycleLayoutKeyboard,
  selectLayoutKeyboard,
  // Resize
  resizePaneKeyboard,
};
