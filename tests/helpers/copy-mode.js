/**
 * Scrollback view helpers
 *
 * Utilities for entering, exiting, and querying the per-pane scrollback state
 * — tmux's copy mode and the native-like scroll view both live in it.
 */

const { waitForCondition } = require('./browser');
const { enterCopyModeKeyboard } = require('./copy-mode-ui');
const { tmuxExec } = require('./tmux-socket');

/**
 * The active pane's scrollback record as the app holds it (`view().copyMode`),
 * with `active: true`; null when the pane has none.
 */
async function getCopyModeState(page) {
  return page.evaluate(() => {
    const record = window.app?.view().copyMode;
    return record ? { active: true, ...record } : null;
  });
}

/** Whether tmux has the app's active pane in a mode (copy mode); null before there is one. */
async function tmuxInMode(page) {
  const paneId = await page.evaluate(() => window.app?.view().activePaneId ?? null);
  if (!paneId) return null;
  return tmuxExec(`display-message -p -t ${paneId} '#{pane_in_mode}'`) === '1';
}

/**
 * Wait for copy mode to become active or inactive.
 * @param {Page} page
 * @param {boolean} active - Whether to wait for active (true) or inactive (false)
 * @param {number} timeout
 * @returns {Promise<Object|null>} Copy mode state if waiting for active, null if waiting for inactive
 */
async function waitForCopyMode(page, active, timeout = 15000) {
  const state = await waitForCondition(
    page,
    async () => {
      const cs = await getCopyModeState(page);
      return active ? (cs?.active ? cs : null) : !cs?.active;
    },
    timeout,
    `copy mode to become ${active ? 'active' : 'inactive'}`,
  );
  return active ? state : null;
}

/**
 * Enter copy mode via keyboard (prefix + [) and wait until it can be DRIVEN:
 * the client has fetched the scrollback it navigates (until those rows land,
 * `k` is accepted and moves nothing) and tmux has the pane in copy mode.
 */
async function enterCopyModeAndWait(page, timeout = 15000) {
  await enterCopyModeKeyboard(page);
  return waitForCondition(
    page,
    async () => {
      const cs = await getCopyModeState(page);
      const ready =
        cs?.mode === 'copy' &&
        !cs.loading &&
        cs.loadedRanges.length > 0 &&
        typeof cs.cursorRow === 'number' &&
        (await tmuxInMode(page));
      return ready ? cs : null;
    },
    timeout,
    async () =>
      `copy mode to load the scrollback with tmux in the mode (client: ${JSON.stringify(
        await getCopyModeState(page),
      )}, tmux in mode: ${await tmuxInMode(page)})`,
  );
}

/**
 * Wait until tmux itself reports the active pane out of copy mode.
 *
 * `waitForCopyMode(page, false)` answers for the CLIENT, which drops its record
 * the instant the user leaves and only then asks tmux to cancel. A test that
 * re-enters on the client's word alone is racing that cancel: the snapshot
 * reporting it can land after the next entry, and a loaded runner is where it
 * does.
 */
async function waitForTmuxOutOfMode(page, timeout = 15000) {
  await waitForCondition(
    page,
    async () => (await tmuxInMode(page)) === false,
    timeout,
    'tmux to report the pane out of copy mode',
  );
}

/**
 * Wheel up over the pane under the mouse until the scroll view opens, and
 * return its state. One tick per poll, each a full row or more, and the view
 * checked before the next: a burst of sub-row deltas can all land before the
 * client has the pane's history size on a slow runner, and a tick that
 * arrives then does nothing.
 */
async function wheelIntoScrollView(page, timeout = 15000) {
  await waitForCondition(
    page,
    async () => {
      if ((await getCopyModeState(page))?.mode === 'scroll') return true;
      await page.mouse.wheel(0, -120);
      return false;
    },
    timeout,
    'the wheel to open the scroll view',
  );
  return getCopyModeState(page);
}

module.exports = {
  getCopyModeState,
  wheelIntoScrollView,
  waitForCopyMode,
  waitForTmuxOutOfMode,
  enterCopyModeAndWait,
};
