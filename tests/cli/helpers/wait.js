/**
 * The CLI suite's one way to wait for something a child does on its own
 * time: look until it is there, and past a deadline fail saying what was
 * awaited and what was there instead.
 */

/**
 * How long a wait lasts before it fails. Under the suite's test timeout
 * (`../jest.config.js`), so the wait is what reports, not Jest.
 */
const WAIT_MS = 15000;
const POLL_MS = 50;

/**
 * Resolve with the first truthy value `look` returns. A falsy one means "not
 * yet": it is asked again until the deadline.
 *
 * @template T
 * @param {string} what - What is awaited, as the failure names it
 * @param {() => T | Promise<T>} look
 * @param {object} [options]
 * @param {() => string} [options.saw] - What is there instead, for the failure
 * @param {() => boolean} [options.over] - Whether it can no longer come (its
 *   writer has exited): fail now rather than at the deadline
 * @param {number} [options.timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(what, look, { saw, over = () => false, timeoutMs = WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let found = await look();
  while (!found) {
    const ended = over();
    // What its writer left on the way out counts.
    if (ended) found = await look();
    if (found) break;
    if (ended || Date.now() > deadline) {
      const gaveUp = ended ? 'it can no longer come' : `not after ${timeoutMs}ms`;
      throw new Error(`waited for ${what}: ${gaveUp}${saw ? `; saw ${saw()}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    found = await look();
  }
  return found;
}

module.exports = { waitFor };
