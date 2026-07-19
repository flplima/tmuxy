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

module.exports = {
  measureTime,
  typeWithTiming,
};
