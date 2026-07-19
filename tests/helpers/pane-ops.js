/**
 * Pane Operations
 *
 * Pane information, split, navigate, swap, zoom, kill, layout, and resize.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');
const {
  sendKeyCombo,
  sendPrefixCommand,
  tmuxCommandKeyboard,
  typeInTerminal,
  pressEnter,
} = require('./keyboard');

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
    return Array.from(logs)
      .map((l) => l.textContent || '')
      .join('\n');
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
      const content = Array.from(logs)
        .map((l) => l.textContent || '')
        .join('\n');
      return content.includes(searchText);
    }, text);
    if (found) return await getTerminalText(page);
    await delay(100);
  }
  const content = await getTerminalText(page);
  throw new Error(
    `Timeout waiting for "${text}" in terminal (${timeout}ms). Content (${content.length} chars): "${content.slice(0, 200)}"`,
  );
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
      const content = Array.from(logs)
        .map((l) => l.textContent || '')
        .join('\n');
      return content.length > 5 && /[$#%>❯]/.test(content);
    });
    if (found) return await getTerminalText(page);
    await delay(100);
  }
  const content = await getTerminalText(page);
  throw new Error(
    `Timeout waiting for shell prompt (${timeout}ms). Content (${content.length} chars): "${content.slice(0, 200)}"`,
  );
}

/**
 * Run a command in terminal and wait for expected output.
 * Types via browser keyboard and verifies output appears in the DOM.
 * No fallbacks — tests the real user path end-to-end.
 */
async function runCommand(page, command, expectedOutput, timeout = 20000) {
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
  runCommand,
  runCommandWithDelay,
  // Split
  splitPaneKeyboard,
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
