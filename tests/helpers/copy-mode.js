/**
 * Scrollback view helpers
 *
 * Utilities for entering, exiting, and querying the per-pane scrollback state
 * — tmux's copy mode and the native-like scroll view both live in it.
 */

const { delay, waitForCondition } = require('./browser');
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
      // 'scroll' (the native-like wheel view) or 'copy' (tmux copy mode) —
      // the two share this record; see ScrollbackMode.
      mode: cs.mode,
      cursorRow: cs.cursorRow,
      cursorCol: cs.cursorCol,
      scrollTop: cs.scrollTop,
      totalLines: cs.totalLines,
      height: cs.height,
      width: cs.width,
      selectionMode: cs.selectionMode,
      selectionAnchor: cs.selectionAnchor,
      // Which rows have actually been fetched: a selection can cover history
      // that is still on its way, and only these rows have text to copy.
      loading: cs.loading,
      loadedRanges: cs.loadedRanges,
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
 * Enter copy mode via keyboard (prefix + [) and wait until it can be DRIVEN.
 *
 * `waitForCopyMode` resolves as soon as the pane has a copy-mode record, which
 * is earlier than the point a motion key does anything: the client fetches the
 * scrollback it is about to navigate, and until those rows land the cursor has
 * nothing to move through — `k` is accepted and changes nothing.
 *
 * So this also waits for the fetch to settle. Previously the gap was covered
 * by `sendPrefixCommand` sleeping 500ms after every prefix key, which happened
 * to be long enough on the machines anyone looked at; a test that pressed `k`
 * three times and asserted the cursor had risen was reading that sleep, not
 * this state.
 */
async function enterCopyModeAndWait(page, timeout = 15000) {
  await enterCopyModeKeyboard(page);
  const entered = await waitForCopyMode(page, true, timeout);

  try {
    await waitForCondition(
      page,
      async () => {
        const cs = await getCopyModeState(page);
        if (!cs?.active) return true; // left copy mode — the caller will say so
        return (
          !cs.loading && (cs.loadedRanges?.length ?? 0) > 0 && typeof cs.cursorRow === 'number'
        );
      },
      timeout,
      'copy mode to finish loading the scrollback it will navigate',
    );
  } catch {
    // Not fatal: a pane with no history to load never reports rows, and the
    // caller's own assertions are a better error than one from here.
  }
  return (await getCopyModeState(page)) ?? entered;
}

module.exports = {
  getCopyModeState,
  waitForCopyMode,
  enterCopyModeAndWait,
};
