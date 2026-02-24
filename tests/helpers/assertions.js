/**
 * Assertion Helpers
 *
 * Comparison and verification utilities for testing
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');

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

/**
 * Get UI state snapshot for consistency verification
 */
async function getUISnapshot(page) {
  return await page.evaluate(() => {
    const result = {
      panes: [],
      windows: [],
      activePaneId: null,
      activeWindowIndex: null,
      terminalContent: {},
    };

    // Get pane info
    const paneElements = document.querySelectorAll('[data-pane-id]');
    const seenPaneIds = new Set();
    for (const el of paneElements) {
      const paneId = el.getAttribute('data-pane-id');
      if (seenPaneIds.has(paneId)) continue;
      seenPaneIds.add(paneId);

      const rect = el.getBoundingClientRect();
      const isActive = el.classList.contains('pane-active') ||
                       el.querySelector('.pane-tab-active') !== null;

      // Get terminal content for this pane
      const terminal = el.querySelector('[role="log"]');
      const content = terminal ? (terminal.textContent || '').trim() : '';

      result.panes.push({
        id: paneId,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        active: isActive,
      });

      result.terminalContent[paneId] = content;

      if (isActive) {
        result.activePaneId = paneId;
      }
    }

    // Fallback for single pane (no data-pane-id)
    if (result.panes.length === 0) {
      const logs = document.querySelectorAll('[role="log"]');
      logs.forEach((log, index) => {
        const rect = log.getBoundingClientRect();
        result.panes.push({
          id: `fallback-${index}`,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          active: index === 0,
        });
        result.terminalContent[`fallback-${index}`] = (log.textContent || '').trim();
      });
      if (result.panes.length > 0) {
        result.activePaneId = result.panes[0].id;
      }
    }

    // Get window tabs
    const windowTabs = document.querySelectorAll('.tab');
    windowTabs.forEach((tab, index) => {
      const isActive = tab.classList.contains('tab-active');
      result.windows.push({
        index,
        name: tab.textContent?.trim() || '',
        active: isActive,
      });
      if (isActive) {
        result.activeWindowIndex = index;
      }
    });

    return result;
  });
}

/**
 * Get tmux state snapshot for consistency verification
 */
function getTmuxSnapshot(session) {
  const panes = session.getPaneInfo();
  const windows = session.getWindowInfo();
  const activePaneId = session.getActivePaneId();
  const currentWindowIndex = session.getCurrentWindowIndex();

  // Capture content for each pane
  const terminalContent = {};
  for (const pane of panes) {
    try {
      const content = session.runCommand(`capture-pane -t ${pane.id} -p`);
      terminalContent[pane.id] = content.trim();
    } catch {
      terminalContent[pane.id] = '';
    }
  }

  return {
    panes: panes.map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      active: p.active,
    })),
    windows: windows.map(w => ({
      index: w.index,
      name: w.name,
      active: w.active,
    })),
    activePaneId,
    activeWindowIndex: parseInt(currentWindowIndex, 10),
    terminalContent,
  };
}

/**
 * Verify mouse drag resulted in expected change
 */
async function verifyMouseDragEffect(page, beforeState, afterAction, expectedChange) {
  await afterAction();
  await delay(DELAYS.LONG);

  const afterState = await getUISnapshot(page);

  switch (expectedChange) {
    case 'resize':
      // At least one pane should have different dimensions
      const sizeChanged = beforeState.panes.some((before, i) => {
        const after = afterState.panes[i];
        if (!after) return true;
        return before.width !== after.width || before.height !== after.height;
      });
      return { success: sizeChanged, before: beforeState, after: afterState };

    case 'focus':
      // Active pane should have changed
      const focusChanged = beforeState.activePaneId !== afterState.activePaneId;
      return { success: focusChanged, before: beforeState, after: afterState };

    case 'reorder':
      // Pane order should have changed
      const orderChanged = beforeState.panes.some((before, i) => {
        const after = afterState.panes[i];
        if (!after) return true;
        return before.id !== after.id;
      });
      return { success: orderChanged, before: beforeState, after: afterState };

    default:
      return { success: true, before: beforeState, after: afterState };
  }
}

module.exports = {
  verifyLayoutChanged,
  getUISnapshot,
  getTmuxSnapshot,
  verifyMouseDragEffect,
};
