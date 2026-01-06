/**
 * Assertion Helpers
 *
 * Comparison and verification utilities for testing
 */

const { getTmuxPaneInfo, getTmuxPaneCount, getActiveTmuxPane, getTmuxWindowCount, isPaneZoomed } = require('./tmux');
const { getUIPaneInfo, getUIPaneCount } = require('./ui');

/**
 * Compare tmux and UI pane counts
 */
async function comparePaneCounts(page, sessionName) {
  const tmuxCount = getTmuxPaneCount(sessionName);
  const uiCount = await getUIPaneCount(page);

  return {
    tmuxCount,
    uiCount,
    match: tmuxCount === uiCount,
  };
}

/**
 * Compare tmux and UI state
 */
async function compareTmuxAndUIState(page, sessionName) {
  const tmuxPanes = getTmuxPaneInfo(sessionName);
  const uiPanes = await getUIPaneInfo(page);

  return {
    tmuxPaneCount: tmuxPanes.length,
    uiPaneCount: uiPanes.length,
    match: tmuxPanes.length === uiPanes.length,
    tmuxPanes,
    uiPanes,
  };
}

/**
 * Verify a split operation succeeded
 */
async function verifySplit(page, sessionName, expectedCount) {
  const tmuxCount = getTmuxPaneCount(sessionName);
  const uiCount = await getUIPaneCount(page);

  return {
    success: tmuxCount === expectedCount && uiCount === expectedCount,
    tmuxCount,
    uiCount,
    expectedCount,
  };
}

/**
 * Verify navigation changed the active pane
 */
function verifyNavigation(sessionName, previousPane) {
  const currentPane = getActiveTmuxPane(sessionName);
  return {
    changed: currentPane !== previousPane,
    previousPane,
    currentPane,
  };
}

/**
 * Verify zoom state
 */
function verifyZoom(sessionName, expectedZoomed) {
  const zoomed = isPaneZoomed(sessionName);
  return {
    match: zoomed === expectedZoomed,
    zoomed,
    expected: expectedZoomed,
  };
}

/**
 * Verify window count
 */
function verifyWindowCount(sessionName, expectedCount) {
  const count = getTmuxWindowCount(sessionName);
  return {
    match: count === expectedCount,
    count,
    expected: expectedCount,
  };
}

/**
 * Verify pane layout changed (positions differ)
 */
function verifyLayoutChanged(beforePanes, afterPanes) {
  if (beforePanes.length !== afterPanes.length) return true;

  return beforePanes.some((p, i) => {
    const newPane = afterPanes[i];
    return p.x !== newPane.x || p.y !== newPane.y ||
           p.width !== newPane.width || p.height !== newPane.height;
  });
}

module.exports = {
  comparePaneCounts,
  compareTmuxAndUIState,
  verifySplit,
  verifyNavigation,
  verifyZoom,
  verifyWindowCount,
  verifyLayoutChanged,
};
