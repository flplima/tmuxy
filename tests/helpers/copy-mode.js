/**
 * Copy Mode Helpers
 *
 * Utilities for entering, exiting, and querying copy mode state.
 */

const { delay } = require('./browser');
const { enterCopyModeKeyboard } = require('./ui');

/**
 * Get copy mode state from the XState machine context.
 * Returns null if copy mode is not active for the current pane.
 */
async function getCopyModeState(page) {
  return page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const paneId = snap.context.activePaneId;
    if (!paneId) return null;
    const cs = snap.context.copyModeStates[paneId];
    if (!cs) return null;
    return {
      active: true,
      cursorRow: cs.cursorRow,
      cursorCol: cs.cursorCol,
      scrollTop: cs.scrollTop,
      totalLines: cs.totalLines,
      height: cs.height,
      width: cs.width,
      selectionMode: cs.selectionMode,
      selectionAnchor: cs.selectionAnchor,
    };
  });
}

/**
 * Wait for copy mode to become active or inactive.
 * @param {Page} page
 * @param {boolean} active - Whether to wait for active (true) or inactive (false)
 * @param {number} timeout
 * @returns {Promise<Object|null>} Copy mode state if waiting for active, null if waiting for inactive
 */
async function waitForCopyMode(page, active, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cs = await getCopyModeState(page);
    if (active && cs?.active) return cs;
    if (!active && !cs?.active) return null;
    await delay(100);
  }
  throw new Error(`Copy mode did not become ${active ? 'active' : 'inactive'} within ${timeout}ms`);
}

/**
 * Enter copy mode via keyboard (prefix + [) and wait for it to become active.
 */
async function enterCopyModeAndWait(page, timeout = 15000) {
  await enterCopyModeKeyboard(page);
  return await waitForCopyMode(page, true, timeout);
}

module.exports = {
  getCopyModeState,
  waitForCopyMode,
  enterCopyModeAndWait,
};
