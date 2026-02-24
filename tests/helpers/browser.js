/**
 * Browser Helpers
 *
 * Playwright setup and browser interaction utilities
 */

const { chromium } = require('playwright');
const { CDP_PORT, TMUXY_URL, DELAYS } = require('./config');

/**
 * Helper to wait for a given time
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Launch a fresh headless browser for tests
 */
// Shared browser instance — launched once via Playwright, reused across all test
// suites in the same Jest run. Never closed until the process exits.
let sharedBrowser = null;

async function getBrowser() {
  if (!sharedBrowser) {
    // Try CDP connection first (external Chrome with --remote-debugging-port)
    try {
      console.log(`Trying CDP connection on port ${CDP_PORT}...`);
      sharedBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
      console.log('Connected to Chrome via CDP');
    } catch {
      // No external Chrome — launch our own headless instance
      console.log('No CDP endpoint, launching headless Chromium');
      sharedBrowser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
    }
  } else {
    console.log('Reusing existing browser connection');
  }

  return {
    _browser: sharedBrowser,
    async newPage() {
      const context = await sharedBrowser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      page._context = context;
      return page;
    },
    async close() {
      // No-op — shared browser persists across suites
    },
  };
}

/**
 * Wait for tmuxy server to be ready
 */
async function waitForServer(url = TMUXY_URL, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await delay(500);
  }
  throw new Error(`Server at ${url} not ready after ${timeout}ms`);
}

/**
 * Navigate to tmuxy with session parameter
 * Includes retry logic for WebSocket connection race conditions
 */
async function navigateToSession(page, sessionName, tmuxyUrl = TMUXY_URL) {
  const url = `${tmuxyUrl}?session=${encodeURIComponent(sessionName)}`;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[role="log"]', { timeout: 10000 });

    // Wait for terminal content (shell prompt)
    try {
      await page.waitForFunction(
        () => {
          const logs = document.querySelectorAll('[role="log"]');
          const content = Array.from(logs).map(l => l.textContent || '').join('\n');
          // Content must have > 5 chars and contain shell prompt
          return content.length > 5 && /[$#%>]/.test(content);
        },
        { timeout: 3000, polling: 50 }
      );
      // Success - terminal content loaded
      await delay(DELAYS.SHORT);
      return url;
    } catch {
      if (attempt < maxRetries) {
        console.log(`Terminal content not ready (attempt ${attempt}/${maxRetries}), retrying...`);
        await delay(500);
      }
    }
  }

  // Final attempt - just continue even if content seems empty
  console.log('Warning: Terminal content may not be fully loaded');
  await delay(DELAYS.MEDIUM);
  return url;
}

/**
 * Focus the page for keyboard input
 */
async function focusPage(page) {
  // Use locator instead of element handle to avoid DOM detachment on re-render
  try {
    await page.locator('[role="log"]').first().click({ timeout: 5000 });
  } catch {
    await page.click('body');
  }
  await delay(DELAYS.MEDIUM);
}

/**
 * Wait for the WebSocket connection to be established and session to be ready
 * This ensures keyboard events will be sent to the correct session
 */
async function waitForSessionReady(page, sessionName, timeout = 5000) {
  const start = Date.now();

  // Wait for the UI to show connected state and have terminal content
  try {
    await page.waitForFunction(
      () => {
        // Check if terminal has content (means connection is established)
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs).map(l => l.textContent || '').join('');
        // Content should have shell prompt
        return content.length > 5 && /[$#%>]/.test(content);
      },
      { timeout, polling: 50 }
    );
  } catch {
    console.log('Warning: Session may not be fully ready');
  }

  // Wait for adapter to be available and responding
  try {
    await page.waitForFunction(
      () => typeof window._adapter?.invoke === 'function',
      { timeout: 5000, polling: 100 }
    );
  } catch {
    console.log('Warning: WebSocket adapter may not be available');
  }

  // Wait for monitor connection to be ready by sending a harmless command
  // The adapter may be available but the monitor (control mode) might not be connected yet
  try {
    await page.waitForFunction(
      async () => {
        try {
          await window._adapter?.invoke('run_tmux_command', { command: 'display-message ""' });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10000, polling: 200 }
    );
  } catch {
    console.log('Warning: Monitor connection may not be ready');
  }

  // Additional delay to ensure keyboard actor has received UPDATE_SESSION
  await delay(DELAYS.LONG);
}

/**
 * Wait for UI to show expected window count
 * @param {Page} page - Playwright page
 * @param {number} expectedCount - Expected window count
 * @param {number} timeout - Max wait time in ms
 */
async function waitForWindowCount(page, expectedCount, timeout = 3000) {
  try {
    await page.waitForFunction(
      (count) => {
        const tabs = document.querySelectorAll('.tab:not(.tab-add)');
        return tabs.length === count;
      },
      expectedCount,
      { timeout, polling: 50 }
    );
  } catch {
    // Timeout - log warning but don't fail
    const actualCount = await page.evaluate(() => {
      return document.querySelectorAll('.tab:not(.tab-add)').length;
    });
    console.log(`Warning: Expected ${expectedCount} windows, found ${actualCount}`);
  }
}

/**
 * Wait for UI to show expected pane count
 * @param {Page} page - Playwright page
 * @param {number} expectedCount - Expected pane count
 * @param {number} timeout - Max wait time in ms
 */
async function waitForPaneCount(page, expectedCount, timeout = 3000) {
  try {
    await page.waitForFunction(
      (count) => {
        // Check both data-pane-id elements and [role="log"] elements
        const paneIds = document.querySelectorAll('[data-pane-id]');
        const logs = document.querySelectorAll('[role="log"]');
        return paneIds.length === count || logs.length === count;
      },
      expectedCount,
      { timeout, polling: 50 }
    );
  } catch {
    // Timeout - log warning but don't fail
    const actualCount = await page.evaluate(() => {
      const paneIds = document.querySelectorAll('[data-pane-id]');
      const logs = document.querySelectorAll('[role="log"]');
      return Math.max(paneIds.length, logs.length);
    });
    console.log(`Warning: Expected ${expectedCount} panes, found ${actualCount}`);
  }
}

module.exports = {
  delay,
  getBrowser,
  waitForServer,
  navigateToSession,
  focusPage,
  waitForSessionReady,
  waitForWindowCount,
  waitForPaneCount,
};
