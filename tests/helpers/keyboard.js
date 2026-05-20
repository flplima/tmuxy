/**
 * Keyboard Helpers
 *
 * Focus, key combos, tmux prefix, typing, and tmux command line.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');

// ==================== Focus Helper ====================

/**
 * Focus the terminal element, clicking the ACTIVE pane's terminal.
 * Clicking a non-active pane triggers FOCUS_PANE → select-pane, which
 * races with subsequent prefix binding commands (e.g., prefix+o).
 * Falls back to any terminal, then body, if the active selector fails.
 */
async function focusTerminal(page) {
  // Prefer the active pane's terminal to avoid changing the active pane
  const activeSelector = '.pane-active [role="log"]';
  try {
    await page.click(activeSelector, { timeout: 2000 });
  } catch {
    // Active pane terminal may not exist yet; try any terminal
    await delay(100);
    try {
      await page.click('[role="log"]', { timeout: 2000 });
    } catch {
      await page.click('body').catch(() => {});
    }
  }
  // Ensure CDP page has input focus (headless Chrome can lose it after DOM re-renders)
  await page.bringToFront();
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
 * Block until the keyboard actor has prefix bindings loaded from the server.
 *
 * The keyboard actor's `prefixBindings` map is populated from an
 * UPDATE_KEYBINDINGS event whose payload comes from the server's
 * `list-keys -T prefix` response. If a prefix-bound keypress (e.g.
 * `prefix+n` → next-window) arrives before that event lands, the actor
 * looks the key up, finds nothing, and silently drops it ("Unknown
 * binding - just ignore (like tmux does)" in keyboardActor.ts).
 *
 * On a slow CI runner the bindings response can lag the first test's
 * first prefix-bound action; locally the cache is usually warm enough
 * to not notice. Wait for prefix_bindings.length > 0 before pressing.
 */
async function waitForKeybindings(page, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await page.evaluate(() => {
      const kb = window.app?.getSnapshot()?.context?.keybindings;
      return Boolean(kb?.prefix_bindings?.length);
    });
    if (ready) return;
    await delay(50);
  }
  throw new Error(`Keybindings (prefix_bindings) not loaded within ${timeout}ms`);
}

/**
 * Send tmux prefix key (dynamically read from XState keybindings)
 *
 * Waits for the keyboard actor to *confirm* it entered prefix mode
 * (via PREFIX_MODE_CHANGE → ctx.prefixActive) before returning. The
 * fixed PREFIX delay used to "give tmux time" isn't actually about
 * tmux — the gate is the frontend keyboardActor's prefix state. On a
 * slow CI runner, 300 ms can land before the actor's keydown handler
 * runs; the subsequent `n` keypress then sees inPrefixMode=false,
 * falls through to send-keys, and the binding never fires.
 */
async function sendTmuxPrefix(page) {
  await focusTerminal(page);
  // Ensure the keyboard actor knows the prefix bindings before any
  // prefix-bound key is delivered — otherwise the second keystroke is
  // silently dropped, and the test waiting on its effect times out.
  await waitForKeybindings(page);
  await delay(DELAYS.MEDIUM);

  // Read the actual prefix key from the browser's XState context
  const prefix = await getPrefixKey(page);
  await page.keyboard.down(prefix.modifier);
  await delay(50);
  await page.keyboard.press(prefix.key);
  await delay(50);
  await page.keyboard.up(prefix.modifier);

  // Wait for the keyboard actor to acknowledge prefix mode rather
  // than relying on a fixed delay.
  await waitForPrefixActive(page);
}

/**
 * Block until ctx.prefixActive flips true. The keyboard actor sends
 * PREFIX_MODE_CHANGE to the app machine right after enterPrefixMode();
 * once the assign lands, we know the next keypress will be looked up
 * in prefixBindings and not silently fall through to send-keys.
 */
async function waitForPrefixActive(page, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const active = await page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.prefixActive === true;
    });
    if (active) return;
    await delay(25);
  }
  throw new Error(`Prefix mode did not activate within ${timeout}ms`);
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
  // Click the active pane's terminal for reliable focus.
  // Using the first [role="log"] would change the active pane via FOCUS_PANE.
  const terminal = (await page.$('.pane-active [role="log"]')) || (await page.$('[role="log"]'));
  if (terminal) {
    await terminal.click();
  } else {
    await page.click('body');
  }
  // Ensure the CDP page has input focus. On headless Chrome, DOM re-renders
  // (split-pane, new-window) can cause the page to lose keyboard focus.
  // bringToFront() re-establishes it at the CDP level.
  await page.bringToFront();
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
  waitForKeybindings,
  waitForPrefixActive,
  sendTmuxPrefix,
  sendPrefixCommand,
  typeChar,
  typeInTerminal,
  pressEnter,
  tmuxCommandKeyboard,
};
