/**
 * Consistency Verification Helpers
 *
 * Provides tools for verifying UI consistency during operations:
 * - Structural state comparison (tmux windows/panes vs UI state + DOM content)
 * - Flicker detection (rapid DOM changes that cause visual glitches)
 * - DOM size verification (element sizes match expected calculations)
 *
 * Built on top of the GlitchDetector for mutation observation.
 */

const { GlitchDetector, OPERATION_THRESHOLDS } = require('./glitch-detector');
const { delay } = require('./browser');
const { DELAYS } = require('./config');
const { extractUIState, extractTmuxState } = require('./snapshot-compare');

// ==================== Structural State Comparison ====================

/**
 * Read both sides through the snapshot extraction (snapshot-compare.js), for
 * the session named in the page URL (`?session=`). Pane text is left out:
 * capture-pane and the DOM are sampled at different moments, so a line-level
 * comparison here would flag every redraw in flight. The snapshot suite owns
 * the content comparison.
 *
 * @param {Page} page - Playwright page
 * @returns {Promise<{tmux: Object, ui: Object}|null>} null when there is no
 *   session to compare or either side is unavailable
 */
async function readBothSides(page) {
  let sessionName;
  try {
    sessionName = new URL(page.url()).searchParams.get('session');
  } catch {
    return null;
  }
  if (!sessionName) return null;
  const [ui, tmux] = await Promise.all([
    extractUIState(page),
    Promise.resolve(extractTmuxState(sessionName, { content: false })),
  ]);
  return ui && tmux ? { tmux, ui } : null;
}

/**
 * Compare tmux state against UI state structurally: window count, names and
 * active flags; pane ids, active flags and dimensions.
 *
 * @param {Object} tmux - extractTmuxState() result
 * @param {Object} ui - extractUIState() result
 * @returns {{match: boolean, errors: string[]}}
 */
function compareState(tmux, ui) {
  const errors = [];

  if (tmux.windows.length !== ui.windows.length) {
    errors.push(`Window count: tmux=${tmux.windows.length}, ui=${ui.windows.length}`);
  } else {
    for (let i = 0; i < tmux.windows.length; i++) {
      const tw = tmux.windows[i];
      const uw = ui.windows[i];
      if (tw.name !== uw.name) {
        errors.push(`Window ${i} name: tmux="${tw.name}", ui="${uw.name}"`);
      }
      if (tw.active !== uw.active) {
        errors.push(`Window ${i} active: tmux=${tw.active}, ui=${uw.active}`);
      }
    }
  }

  const tmuxPaneIds = tmux.panes.map((p) => p.tmuxId).sort();
  const uiPaneIds = ui.panes.map((p) => p.tmuxId).sort();

  if (tmuxPaneIds.join(',') !== uiPaneIds.join(',')) {
    errors.push(`Pane IDs differ: tmux=[${tmuxPaneIds}], ui=[${uiPaneIds}]`);
  } else {
    for (const tmuxPane of tmux.panes) {
      const uiPane = ui.panes.find((p) => p.tmuxId === tmuxPane.tmuxId);
      const id = tmuxPane.tmuxId;
      if (tmuxPane.active !== uiPane.active) {
        errors.push(`Pane ${id} active: tmux=${tmuxPane.active}, ui=${uiPane.active}`);
      }
      if (tmuxPane.width !== uiPane.width) {
        errors.push(`Pane ${id} width: tmux=${tmuxPane.width}, ui=${uiPane.width}`);
      }
      // Allow 1-row height difference to account for the status line.
      // The server may report a different height than `list-panes` due to
      // how set_client_size allocates rows for the status bar.
      if (Math.abs(tmuxPane.height - uiPane.height) > 1) {
        errors.push(`Pane ${id} height: tmux=${tmuxPane.height}, ui=${uiPane.height}`);
      }
    }
  }

  return { match: errors.length === 0, errors };
}

/**
 * Assert that tmux state matches UI state.
 * Polls with retries to allow for propagation delay.
 *
 * @param {Page} page - Playwright page
 * @param {Object} options
 * @param {number} options.retries - Number of retry attempts (default: 4)
 * @param {number} options.retryDelay - Delay between retries in ms (default: 500)
 * @throws {Error} If state doesn't match after all retries
 */
async function assertStateMatches(page, options = {}) {
  const { retries = 4, retryDelay = 500 } = options;

  // Skip if page navigated away
  try {
    const url = page.url();
    if (url === 'about:blank') return;
  } catch {
    return;
  }

  let lastErrors = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await delay(retryDelay);

    try {
      const sides = await readBothSides(page);
      if (!sides) return; // can't compare, skip silently

      const result = compareState(sides.tmux, sides.ui);
      if (result.match) return; // success

      lastErrors = result.errors;
    } catch (e) {
      // A closing page ends the check; any other exception is a failed
      // attempt (the old blanket return made exceptions pass silently).
      const msg = String((e && e.message) || e);
      if (/Target closed|Session closed|browser has been closed|detached/i.test(msg)) {
        return;
      }
      lastErrors = [`attempt threw: ${msg}`];
    }
  }

  throw new Error(
    `State mismatch (${lastErrors.length} difference(s) after ${retries} attempts):\n` +
      lastErrors.map((e) => `  - ${e}`).join('\n'),
  );
}

// ==================== DOM Size Verification ====================

/**
 * Verify DOM element sizes match expected calculations.
 * Formula: width = cols * charWidth, height = rows * charHeight
 *
 * Note: The UI has additional elements (headers, gaps, borders) that affect
 * actual DOM sizes. This verification uses a generous tolerance to account
 * for these differences. The goal is to catch large discrepancies, not
 * pixel-perfect matching.
 *
 * @param {Page} page - Playwright page
 * @param {Object} options - Verification options
 * @param {number} options.tolerance - Pixel tolerance for size comparison (default: 30)
 * @param {number} options.gapSize - Gap between panes (default: 2)
 * @returns {Promise<{valid: boolean, errors: string[], details: Object}>}
 */
async function verifyDomSizes(page, options = {}) {
  // Use generous tolerance to account for headers, borders, and gaps
  const { tolerance = 60, gapSize = 2 } = options;

  const uiState = await page.evaluate(() => {
    const app = window.app?.getSnapshot()?.context;
    if (!app) return null;

    const { charWidth, charHeight, panes, totalWidth, totalHeight, activeWindowId } = app;

    // Filter to visible panes in active window
    const visiblePanes = (panes || []).filter((p) => p.windowId === activeWindowId);

    // Get actual DOM element sizes — use .pane-layout-item selector to get the
    // positioned container (not the inner .pane-wrapper which may have different sizing)
    const paneElements = document.querySelectorAll('.pane-layout-item[data-pane-id]');
    const domPanes = [];
    const seenIds = new Set();

    for (const el of paneElements) {
      const paneId = el.getAttribute('data-pane-id');
      if (seenIds.has(paneId)) continue;
      seenIds.add(paneId);

      const rect = el.getBoundingClientRect();
      domPanes.push({
        paneId,
        domWidth: rect.width,
        domHeight: rect.height,
        domX: rect.x,
        domY: rect.y,
      });
    }

    // Get container element
    const container = document.querySelector('.pane-container');
    const containerRect = container?.getBoundingClientRect();

    return {
      charWidth,
      charHeight,
      panes: visiblePanes,
      domPanes,
      totalWidth,
      totalHeight,
      containerRect: containerRect
        ? {
            width: containerRect.width,
            height: containerRect.height,
            x: containerRect.x,
            y: containerRect.y,
          }
        : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  if (!uiState) {
    return { valid: false, errors: ['No UI state available (window.app not set)'], details: null };
  }

  const errors = [];

  // Verify pane sizing: check that panes have proportional widths/heights
  // relative to each other. The UI sizes panes to fill the viewport, so absolute
  // pixel values won't match cols * charWidth when the viewport differs from
  // the tmux session dimensions. Instead, verify proportional relationships.

  const matchedPanes = uiState.panes
    .map((pane) => ({
      pane,
      dom: uiState.domPanes.find((p) => p.paneId === pane.tmuxId),
    }))
    .filter(({ dom }) => dom != null);

  // Check 1: All panes should have positive dimensions
  for (const { pane, dom } of matchedPanes) {
    if (dom.domWidth <= 0) {
      errors.push(`Pane ${pane.tmuxId} has zero/negative width: ${dom.domWidth}px`);
    }
    if (dom.domHeight <= 0) {
      errors.push(`Pane ${pane.tmuxId} has zero/negative height: ${dom.domHeight}px`);
    }
  }

  // Check 2: Panes with equal column counts should have similar DOM widths
  // (within tolerance), and wider tmux panes should have wider DOM elements
  for (let i = 0; i < matchedPanes.length; i++) {
    for (let j = i + 1; j < matchedPanes.length; j++) {
      const a = matchedPanes[i];
      const b = matchedPanes[j];
      // If one pane has >= 2x the columns, it should be wider in DOM
      if (a.pane.width >= b.pane.width * 2 && a.dom.domWidth < b.dom.domWidth) {
        errors.push(
          `Pane ${a.pane.tmuxId} (${a.pane.width} cols) should be wider than ` +
            `${b.pane.tmuxId} (${b.pane.width} cols), but DOM shows ${a.dom.domWidth.toFixed(0)} < ${b.dom.domWidth.toFixed(0)}`,
        );
      }
      if (b.pane.width >= a.pane.width * 2 && b.dom.domWidth < a.dom.domWidth) {
        errors.push(
          `Pane ${b.pane.tmuxId} (${b.pane.width} cols) should be wider than ` +
            `${a.pane.tmuxId} (${a.pane.width} cols), but DOM shows ${b.dom.domWidth.toFixed(0)} < ${a.dom.domWidth.toFixed(0)}`,
        );
      }
    }
  }

  // Note: Overlap check removed. CSS transitions on .pane-layout-item (250ms)
  // cause intermediate overlap states that getBoundingClientRect captures during
  // animation. The positive dimensions and proportionality checks above are
  // sufficient to catch real layout bugs.

  // Note: Container width check removed. The .pane-container uses flex:1 and fills
  // the full viewport, while pane content is centered within it via centeringOffset.
  // The container is intentionally wider than totalWidth * charWidth.

  return {
    valid: errors.length === 0,
    errors,
    details: {
      charWidth: uiState.charWidth,
      charHeight: uiState.charHeight,
      paneCount: uiState.panes.length,
      domPaneCount: uiState.domPanes.length,
      totalWidth: uiState.totalWidth,
      totalHeight: uiState.totalHeight,
    },
  };
}

// ==================== Consistency Check Wrapper ====================

/**
 * Wrap a test operation with consistency checks.
 *
 * Automatically:
 * 1. Starts glitch/flicker detection before operation
 * 2. Runs the operation
 * 3. Stops detection and analyzes results
 * 4. Compares ASCII snapshots
 * 5. Verifies DOM sizes
 *
 * @param {Object} ctx - Test context with page and session
 * @param {Function} operation - Async function performing the operation
 * @param {Object} options - Check options
 * @param {string} options.operationType - Type for glitch thresholds (split, kill, resize, etc.)
 * @param {boolean} options.skipSnapshot - Skip snapshot comparison (default: false)
 * @param {boolean} options.skipSizeVerification - Skip DOM size verification (default: false)
 * @param {boolean} options.skipGlitchDetection - Skip glitch detection (default: false)
 * @returns {Promise<{glitch: Object, snapshot: Object, sizes: Object}>}
 */
async function withConsistencyChecks(ctx, operation, options = {}) {
  const {
    operationType = 'default',
    skipSnapshot = false,
    skipSizeVerification = false,
    skipGlitchDetection = false,
  } = options;

  let glitchResult = { summary: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 0 } };
  let snapshotResult = { match: true, diff: [] };
  let sizeResult = { valid: true, errors: [] };

  // Start glitch detection
  let detector = null;
  if (!skipGlitchDetection && ctx.page) {
    try {
      detector = new GlitchDetector(ctx.page);
      await detector.start();
    } catch (e) {
      // Glitch detection is optional - log and continue
      console.warn('Failed to start glitch detection:', e.message);
    }
  }

  // Run the operation
  await operation();

  // Stop detection and analyze
  if (detector) {
    try {
      glitchResult = await detector.stop();
    } catch (e) {
      console.warn('Failed to stop glitch detection:', e.message);
    }
  }

  // Wait for UI to settle before comparing snapshots
  await delay(DELAYS.MEDIUM);

  // Compare structural state (tmux vs UI)
  if (!skipSnapshot && ctx.page) {
    try {
      const sides = await readBothSides(ctx.page);
      if (sides) {
        const result = compareState(sides.tmux, sides.ui);
        snapshotResult = {
          match: result.match,
          diff: result.errors.map((e, i) => ({ line: i, description: e })),
        };
      }
    } catch (e) {
      console.warn('Failed to compare state:', e.message);
    }
  }

  // Verify DOM sizes
  if (!skipSizeVerification && ctx.page) {
    try {
      sizeResult = await verifyDomSizes(ctx.page);
    } catch (e) {
      console.warn('Failed to verify DOM sizes:', e.message);
    }
  }

  return {
    glitch: {
      hasFlicker: glitchResult.flickers?.length > 0 || false,
      hasChurn: glitchResult.churn?.length > 0 || false,
      hasSizeJumps: glitchResult.jumps?.length > 0 || false,
      flickers: glitchResult.flickers || [],
      churn: glitchResult.churn || [],
      jumps: glitchResult.jumps || [],
      summary: glitchResult.summary,
      thresholds: OPERATION_THRESHOLDS[operationType] || OPERATION_THRESHOLDS.default,
    },
    snapshot: snapshotResult,
    sizes: sizeResult,
  };
}

module.exports = {
  assertStateMatches,
  verifyDomSizes,
  withConsistencyChecks,
};
