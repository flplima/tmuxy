/**
 * Copy Mode Helpers
 *
 * Utilities for entering, exiting, and querying copy mode state.
 */

const { delay } = require('./browser');
const { enterCopyModeKeyboard } = require('./ui');

/**
 * Get copy mode state for the active pane from the XState machine context.
 * Returns null if copy mode is not active for the current pane.
 *
 * Copy mode is now NATIVE: tmux owns the cursor and selection, surfaced on the
 * pane model (inMode, copyCursorX/Y, selectionPresent, selectionStartX/Y). The
 * returned shape keeps the legacy field names (cursorRow/cursorCol/selectionMode
 * /selectionAnchor) as aliases over the native fields so existing assertions
 * read naturally. Coordinates are visible-viewport relative.
 */
async function getCopyModeState(page) {
  return page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const paneId = snap.context.activePaneId;
    if (!paneId) return null;
    const pane = snap.context.panes.find((p) => p.tmuxId === paneId);
    if (!pane || !pane.inMode) return null;
    return {
      active: true,
      // Native copy cursor (visible-relative). cursorRow/cursorCol are aliases.
      cursorRow: pane.copyCursorY,
      cursorCol: pane.copyCursorX,
      copyCursorX: pane.copyCursorX,
      copyCursorY: pane.copyCursorY,
      height: pane.height,
      width: pane.width,
      historySize: pane.historySize,
      // tmux reports a single selection flag; expose it as selectionPresent and
      // as a legacy 'char'/null selectionMode + selectionAnchor for assertions.
      selectionPresent: pane.selectionPresent,
      selectionMode: pane.selectionPresent ? 'char' : null,
      selectionAnchor: pane.selectionPresent
        ? { row: pane.selectionStartY, col: pane.selectionStartX }
        : null,
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
