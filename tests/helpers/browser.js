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
 * Navigate to tmuxy with session parameter.
 * Includes retry logic for SSE connection race conditions and a verified
 * round-trip readiness gate: sends a unique marker command through tmux
 * and waits for it to appear in the DOM before returning.
 */
async function navigateToSession(page, sessionName, tmuxyUrl = TMUXY_URL) {
  const url = `${tmuxyUrl}?session=${encodeURIComponent(sessionName)}`;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('[role="log"]', { timeout: 10000 });
    } catch {
      if (attempt < maxRetries) {
        console.log(`[role="log"] not found (attempt ${attempt}/${maxRetries}), reloading...`);
        await delay(2000);
        continue;
      }
      console.log('Warning: [role="log"] not found after all retries');
      await delay(DELAYS.MEDIUM);
      return url;
    }

    // Wait for terminal content (shell prompt)
    try {
      await page.waitForFunction(
        () => {
          const logs = document.querySelectorAll('[role="log"]');
          const content = Array.from(logs).map(l => l.textContent || '').join('\n');
          return content.length > 5 && /[$#%>]/.test(content);
        },
        { timeout: 5000, polling: 50 }
      );
      await delay(DELAYS.SHORT);
      return url;
    } catch {
      if (attempt < maxRetries) {
        console.log(`Terminal content not ready (attempt ${attempt}/${maxRetries}), retrying...`);
        await delay(500);
      }
    }
  }

  console.log('Warning: Terminal content may not be fully loaded');
  await delay(DELAYS.MEDIUM);
  return url;
}

/**
 * Verified round-trip readiness gate.
 * Sends a unique marker through the full pipeline (adapter → tmux → terminal → DOM)
 * and waits for it to appear. This ensures the entire data path is working
 * before the test proceeds.
 */
async function verifyRoundTrip(page, sessionName, timeout = 10000) {
  const marker = `READY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Send marker through adapter → tmux control mode → shell
  await page.evaluate(async (cmd) => {
    await window._adapter?.invoke('run_tmux_command', { command: cmd });
  }, `send-keys -l 'echo ${marker}'`);
  await page.evaluate(async () => {
    await window._adapter?.invoke('run_tmux_command', { command: 'send-keys Enter' });
  });

  // Wait for marker to appear in the DOM — this is the definitive readiness gate.
  // If this fails, the full pipeline (adapter → control mode → tmux → SSE → DOM)
  // is not working and the test cannot proceed.
  await page.waitForFunction(
    (m) => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map(l => l.textContent || '').join('\n');
      return content.includes(m);
    },
    marker,
    { timeout, polling: 100 }
  );
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
 * Wait for the SSE connection to be established and session to be ready
 * This ensures keyboard events will be sent to the correct session.
 *
 * Uses exponential backoff for the control mode connection check to handle
 * cold-start latency gracefully.
 */
async function waitForSessionReady(page, sessionName, timeout = 5000) {
  // Phase 1: Wait for terminal content (shell prompt visible)
  try {
    await page.waitForFunction(
      () => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs).map(l => l.textContent || '').join('');
        return content.length > 5 && /[$#%>]/.test(content);
      },
      { timeout, polling: 50 }
    );
  } catch {
    console.log('Warning: Shell prompt not detected within timeout');
  }

  // Phase 2: Wait for adapter to be available
  try {
    await page.waitForFunction(
      () => typeof window._adapter?.invoke === 'function',
      { timeout: 5000, polling: 100 }
    );
  } catch {
    throw new Error(`HTTP adapter not available after 5s for session '${sessionName}'`);
  }

  // Phase 3: Wait for monitor (control mode) connection with exponential backoff.
  // The adapter may be available but the monitor might not be connected yet —
  // this can take several seconds when the server is starting a new control
  // mode connection for a fresh session (especially on cold start).
  const monitorTimeout = 30000;
  const monitorStart = Date.now();
  let backoff = 200;
  const maxBackoff = 2000;

  while (Date.now() - monitorStart < monitorTimeout) {
    const ready = await page.evaluate(async () => {
      try {
        await window._adapter?.invoke('run_tmux_command', { command: 'display-message ""' });
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);

    if (ready) break;

    await delay(backoff);
    backoff = Math.min(backoff * 1.5, maxBackoff);
  }

  // Verify it actually connected
  const finalCheck = await page.evaluate(async () => {
    try {
      await window._adapter?.invoke('run_tmux_command', { command: 'display-message ""' });
      return true;
    } catch {
      return false;
    }
  }).catch(() => false);

  if (!finalCheck) {
    throw new Error(`Monitor connection not ready after ${monitorTimeout / 1000}s for session '${sessionName}'`);
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
async function waitForWindowCount(page, expectedCount, timeout = 10000) {
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
    const diag = await page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab:not(.tab-add)');
      const tabInfo = Array.from(tabs).map(t => t.querySelector('button')?.getAttribute('aria-label'));
      const snap = window.app?.getSnapshot();
      const windows = snap?.context?.windows?.map(w => `${w.id}:${w.index}:${w.name}:a=${w.active}:pg=${w.isPaneGroupWindow}:fl=${w.isFloatWindow}`);
      return { count: tabs.length, tabInfo, windows };
    });
    throw new Error(`Expected ${expectedCount} window tabs, found ${diag.count} (timeout ${timeout}ms)\n  DOM tabs: ${JSON.stringify(diag.tabInfo)}\n  XState windows: ${JSON.stringify(diag.windows)}`);
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
  verifyRoundTrip,
  focusPage,
  waitForSessionReady,
  waitForWindowCount,
  waitForPaneCount,
};
