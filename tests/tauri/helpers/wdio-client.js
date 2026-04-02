/**
 * WebdriverIO client wrapper for Tauri E2E tests
 *
 * Provides a thin abstraction over WebdriverIO's `remote()` that mirrors
 * the Playwright-based helpers used in the web E2E tests, adapting
 * page.evaluate → driver.execute, page.keyboard → driver.keys, etc.
 */

const { remote } = require('webdriverio');
const path = require('path');
const { DRIVER_PORT } = require('./tauri-driver');

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
const TAURI_BINARY = path.join(WORKSPACE_ROOT, 'target/debug/tmuxy');

// WebDriver Unicode key codes for special keys
const KEYS = {
  Enter: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  ArrowUp: '\uE013',
  ArrowDown: '\uE014',
  ArrowLeft: '\uE012',
  ArrowRight: '\uE011',
  Control: '\uE009',
  Shift: '\uE008',
  Alt: '\uE00A',
  Meta: '\uE03D',
};

/**
 * Create a new WebdriverIO session connected to tauri-driver.
 * Each session launches a new Tauri app instance with a unique tmux session.
 *
 * @param {Object} options
 * @param {string} [options.sessionName] - TMUXY_SESSION name (default: auto-generated)
 * @returns {Promise<{driver: WebdriverIO.Browser, sessionName: string}>}
 */
async function createSession(options = {}) {
  // tauri-driver doesn't forward `tauri:options.env` to the spawned binary's
  // std::env, so TMUXY_SESSION must be set in the process environment before
  // tauri-driver starts, or we use the default session name ("tmuxy").
  // For test isolation, each test kills and re-creates the "tmuxy" session.
  const sessionName = options.sessionName || 'tmuxy';

  // Pre-create the tmux session. The Tauri binary's built-in session creation
  // can fail when the tmuxy config contains settings (like `window-size manual`)
  // that crash tmux on a fresh start without an attached client.
  const { execSync } = require('child_process');
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
  } catch {
    // Session may not exist yet
  }
  try {
    execSync(`tmux new-session -d -s ${sessionName}`, { stdio: 'ignore' });
  } catch {
    // Session may already exist
  }

  const driver = await remote({
    hostname: 'localhost',
    port: DRIVER_PORT,
    capabilities: {
      'tauri:options': {
        application: TAURI_BINARY,
        env: {
          DISPLAY: process.env.DISPLAY || ':99',
        },
      },
    },
    // WebdriverIO config
    logLevel: 'warn',
    connectionRetryTimeout: 30000,
    connectionRetryCount: 3,
  });

  return { driver, sessionName };
}

/**
 * Wait for the Tauri app's UI to be ready (terminal element visible with content).
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} timeout - Max wait time in ms
 */
async function waitForAppReady(driver, timeout = 30000) {
  // Wait for [role="log"] to exist
  const terminal = await driver.$('[role="log"]');
  await terminal.waitForExist({ timeout });

  // Wait for terminal to have content (shell prompt)
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hasContent = await driver.execute(() => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map(l => l.textContent || '').join('\n');
      return content.length > 5 && /[$#%>❯]/.test(content);
    });
    if (hasContent) return;
    await driver.pause(200);
  }
  throw new Error(`App not ready within ${timeout}ms`);
}

/**
 * Wait for window.app (XState machine) to be available.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} timeout
 */
async function waitForXState(driver, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await driver.execute(() => {
      return !!window.app?.getSnapshot;
    });
    if (ready) return;
    await driver.pause(200);
  }
  throw new Error(`window.app not available within ${timeout}ms`);
}

/**
 * Get terminal text content from all [role="log"] elements.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<string>}
 */
async function getTerminalText(driver) {
  return driver.execute(() => {
    const logs = document.querySelectorAll('[role="log"]');
    return Array.from(logs).map(l => l.textContent || '').join('\n');
  });
}

/**
 * Wait for specific text to appear in the terminal.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} text
 * @param {number} timeout
 */
async function waitForTerminalText(driver, text, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const content = await getTerminalText(driver);
    if (content.includes(text)) return content;
    await driver.pause(200);
  }
  const content = await getTerminalText(driver);
  throw new Error(
    `Timeout waiting for "${text}" in terminal (${timeout}ms). Content: "${content.slice(0, 200)}"`
  );
}

/**
 * Type text into the terminal via WebDriver keys.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} text
 */
async function typeKeys(driver, text) {
  // Click terminal element first for focus
  const terminal = await driver.$('[role="log"]');
  if (await terminal.isExisting()) {
    await terminal.click();
    await driver.pause(100);
  }

  // Type each character
  for (const char of text) {
    await driver.keys(char);
    await driver.pause(30);
  }
}

/**
 * Press a special key (Enter, Escape, etc.)
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} key - Key name from KEYS map
 */
async function pressKey(driver, key) {
  const code = KEYS[key];
  if (!code) throw new Error(`Unknown key: ${key}. Available: ${Object.keys(KEYS).join(', ')}`);
  await driver.keys([code]);
  await driver.pause(100);
}

/**
 * Send a key combination (e.g., Ctrl+A).
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string[]} keys - Array of key names, e.g. ['Control', 'a']
 */
async function sendKeyCombo(driver, ...keys) {
  const codes = keys.map(k => KEYS[k] || k);
  await driver.keys(codes);
  await driver.pause(100);
}

/**
 * Get the XState machine context from the browser.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<Object|null>}
 */
async function getAppState(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const ctx = snap.context;
    return {
      sessionName: ctx.sessionName,
      adapterType: '__TAURI_INTERNALS__' in window ? 'tauri' : 'http',
      panes: ctx.panes?.map(p => ({
        id: p.tmuxId,
        windowId: p.windowId,
        active: p.active,
        width: p.width,
        height: p.height,
      })),
      windows: ctx.windows?.map(w => ({
        id: w.id,
        index: w.index,
        name: w.name,
        active: w.active,
      })),
      activeWindowId: ctx.activeWindowId,
      activePaneId: ctx.activePaneId,
      keybindings: ctx.keybindings,
    };
  });
}

/**
 * Get the number of panes in the active window.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<number>}
 */
async function getPaneCount(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return 0;
    const ctx = snap.context;
    return ctx.panes?.filter(p => p.windowId === ctx.activeWindowId).length || 0;
  });
}

/**
 * Get the number of visible windows (excluding pane group / float windows).
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<number>}
 */
async function getWindowCount(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return 0;
    return snap.context.windows?.filter(w => !w.isPaneGroupWindow && !w.isFloatWindow).length || 0;
  });
}

/**
 * Invoke a Tauri command via the frontend's adapter.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} command - Tauri command name (e.g., 'run_tmux_command')
 * @param {Object} args - Command arguments
 * @returns {Promise<*>}
 */
async function invokeCommand(driver, command, args = {}) {
  // Use executeAsync because Tauri invoke() returns a Promise, and the WebDriver
  // execute/sync endpoint doesn't support async functions in WebKitWebDriver.
  return driver.executeAsync(
    (cmd, a, done) => {
      window.__TAURI_INTERNALS__?.invoke(cmd, a)
        .then(result => {
          if (result == null) return done(null);
          // Sanitize control characters (U+0000–U+001F) that break WebDriver JSON
          if (typeof result === 'string') {
            return done(result.replace(/[\x00-\x1f]/g, ''));
          }
          done(JSON.parse(JSON.stringify(result)));
        })
        .catch(e => done({ __error: e?.message || String(e) }));
    },
    command,
    args
  );
}

/**
 * Wait for pane count to reach expected value.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} expected
 * @param {number} timeout
 */
async function waitForPaneCount(driver, expected, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getPaneCount(driver);
    if (count === expected) return;
    await driver.pause(200);
  }
  const actual = await getPaneCount(driver);
  throw new Error(`Expected ${expected} panes, got ${actual} (timeout ${timeout}ms)`);
}

/**
 * Wait for window count to reach expected value.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} expected
 * @param {number} timeout
 */
async function waitForWindowCount(driver, expected, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getWindowCount(driver);
    if (count === expected) return;
    await driver.pause(200);
  }
  const actual = await getWindowCount(driver);
  throw new Error(`Expected ${expected} windows, got ${actual} (timeout ${timeout}ms)`);
}

module.exports = {
  createSession,
  waitForAppReady,
  waitForXState,
  getTerminalText,
  waitForTerminalText,
  typeKeys,
  pressKey,
  sendKeyCombo,
  getAppState,
  getPaneCount,
  getWindowCount,
  invokeCommand,
  waitForPaneCount,
  waitForWindowCount,
  KEYS,
  TAURI_BINARY,
};
