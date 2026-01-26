/**
 * Browser Helpers
 *
 * Playwright setup and browser interaction utilities
 */

const { chromium } = require('playwright');
const { TMUXY_URL, DELAYS } = require('./config');

/**
 * Helper to wait for a given time
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Launch a fresh headless browser for tests
 */
async function getBrowser() {
  console.log('Launching headless Chromium via Playwright');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Create a wrapper that mimics Puppeteer's browser API
  return {
    _browser: browser,
    async newPage() {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      // Add Puppeteer-compatible helpers
      page._context = context;
      return page;
    },
    async close() {
      await browser.close();
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
        { timeout: 5000, polling: 100 }
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
  await page.click('body');
  await delay(DELAYS.MEDIUM);
}

module.exports = {
  delay,
  getBrowser,
  waitForServer,
  navigateToSession,
  focusPage,
};
