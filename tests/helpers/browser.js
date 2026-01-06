/**
 * Browser Helpers
 *
 * Puppeteer setup and browser interaction utilities
 */

const puppeteer = require('puppeteer');
const { CDP_PORT, TMUXY_URL, DELAYS } = require('./config');

/**
 * Helper to wait for a given time
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if Chrome DevTools Protocol is available
 */
async function isCdpAvailable(port = CDP_PORT) {
  try {
    const response = await fetch(`http://localhost:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Connect to existing CDP or launch headless browser
 */
async function getBrowser() {
  const cdpAvailable = await isCdpAvailable();

  if (cdpAvailable) {
    console.log(`Connecting to existing Chrome on port ${CDP_PORT}`);
    const response = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    const data = await response.json();
    console.log(`Using WebSocket endpoint: ${data.webSocketDebuggerUrl}`);

    return await puppeteer.connect({
      browserWSEndpoint: data.webSocketDebuggerUrl,
      defaultViewport: { width: 1280, height: 720 },
    });
  }

  console.log('Launching headless Chrome');
  return await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
    defaultViewport: { width: 1280, height: 720 },
    timeout: 30000,
  });
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
 */
async function navigateToSession(page, sessionName, tmuxyUrl = TMUXY_URL) {
  const url = `${tmuxyUrl}?session=${encodeURIComponent(sessionName)}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('[role="log"]', { timeout: 10000 });
  await delay(DELAYS.EXTRA_LONG); // Give tmux state time to sync
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
  isCdpAvailable,
  getBrowser,
  waitForServer,
  navigateToSession,
  focusPage,
};
