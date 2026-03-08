/**
 * Keyboard Helpers
 *
 * Focus, key combos, tmux prefix, typing, and tmux command line.
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

  // Send prefix key (includes focus, delay, and PREFIX wait)
  await sendTmuxPrefix(page);

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

module.exports = {
  focusTerminal,
  sendKeyCombo,
  getPrefixKey,
  sendTmuxPrefix,
  sendPrefixCommand,
  typeChar,
  typeInTerminal,
  pressEnter,
  tmuxCommandKeyboard,
};
