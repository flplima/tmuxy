/**
 * Performance Helpers
 *
 * Utilities for measuring and asserting timing in performance tests
 */

const { delay } = require('./browser');

/**
 * Measure time for an async operation
 * @param {Function} fn - Async function to measure
 * @returns {Promise<number>} - Elapsed time in milliseconds
 */
async function measureTime(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Assert operation completes within threshold
 * @param {Function} fn - Async function to measure
 * @param {number} maxMs - Maximum allowed time in milliseconds
 * @param {string} description - Description for error message
 * @returns {Promise<number>} - Elapsed time in milliseconds
 */
async function assertCompletesWithin(fn, maxMs, description) {
  const elapsed = await measureTime(fn);
  if (elapsed > maxMs) {
    throw new Error(`${description} took ${elapsed.toFixed(0)}ms (max: ${maxMs}ms)`);
  }
  return elapsed;
}

/**
 * Send keys with timing measurement
 * @param {Page} page - Playwright page
 * @param {string[]} keys - Array of key names to press
 * @returns {Promise<number>} - Elapsed time in milliseconds
 */
async function sendKeysWithTiming(page, keys) {
  const start = performance.now();
  for (const key of keys) {
    await page.keyboard.press(key);
  }
  return performance.now() - start;
}

/**
 * Type characters with timing measurement
 * @param {Page} page - Playwright page
 * @param {string} text - Text to type
 * @returns {Promise<number>} - Elapsed time for typing (not including verification)
 */
async function typeWithTiming(page, text) {
  const start = performance.now();
  await page.keyboard.type(text, { delay: 0 });
  return performance.now() - start;
}

/**
 * Measure round-trip time for a keyboard action
 * Types text and waits for it to appear in terminal
 * @param {Page} page - Playwright page
 * @param {string} text - Text to type
 * @param {number} timeout - Max time to wait for text to appear
 * @returns {Promise<number>} - Round-trip time in milliseconds
 */
async function measureKeyboardRoundTrip(page, text, timeout = 5000) {
  const start = performance.now();
  await page.keyboard.type(text, { delay: 0 });

  // Wait for text to appear in terminal
  await page.waitForFunction(
    (searchText) => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map(l => l.textContent || '').join('\n');
      return content.includes(searchText);
    },
    text,
    { timeout, polling: 50 }
  );

  return performance.now() - start;
}

/**
 * Send a control key combination and measure time to process
 * @param {Page} page - Playwright page
 * @param {string} key - Key to send with Control modifier
 * @returns {Promise<number>} - Time to send keys (not including side effects)
 */
async function sendCtrlKeyWithTiming(page, key) {
  const start = performance.now();
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  return performance.now() - start;
}

/**
 * Send tmux prefix sequence and measure time
 * @param {Page} page - Playwright page
 * @param {string} key - Key to send after prefix
 * @returns {Promise<number>} - Time for full sequence
 */
async function sendPrefixSequenceWithTiming(page, key) {
  const start = performance.now();

  // Send Ctrl+A (prefix)
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');

  // Small delay for prefix mode
  await delay(50);

  // Send command key
  await page.keyboard.press(key);

  return performance.now() - start;
}

/**
 * Measure mouse click time
 * @param {Page} page - Playwright page
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Promise<number>} - Time for click
 */
async function clickWithTiming(page, x, y) {
  const start = performance.now();
  await page.mouse.click(x, y);
  return performance.now() - start;
}

/**
 * Measure mouse drag time
 * @param {Page} page - Playwright page
 * @param {number} startX - Start X coordinate
 * @param {number} startY - Start Y coordinate
 * @param {number} endX - End X coordinate
 * @param {number} endY - End Y coordinate
 * @param {Object} options - Drag options
 * @returns {Promise<number>} - Time for drag operation
 */
async function dragWithTiming(page, startX, startY, endX, endY, options = {}) {
  const { steps = 10 } = options;
  const start = performance.now();

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps });
  await page.mouse.up();

  return performance.now() - start;
}

/**
 * Send multiple wheel events and measure total time
 * @param {Page} page - Playwright page
 * @param {number} count - Number of wheel events
 * @param {number} deltaY - Delta for each wheel event
 * @param {Object} position - {x, y} for wheel events
 * @returns {Promise<number>} - Total time for all wheel events
 */
async function scrollWithTiming(page, count, deltaY, position = { x: 400, y: 300 }) {
  const start = performance.now();

  await page.mouse.move(position.x, position.y);
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY);
  }

  return performance.now() - start;
}

module.exports = {
  measureTime,
  assertCompletesWithin,
  sendKeysWithTiming,
  typeWithTiming,
  measureKeyboardRoundTrip,
  sendCtrlKeyWithTiming,
  sendPrefixSequenceWithTiming,
  clickWithTiming,
  dragWithTiming,
  scrollWithTiming,
};
