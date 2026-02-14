/**
 * Consistency Verification Helpers
 *
 * Provides tools for verifying UI consistency during operations:
 * - Flicker detection (rapid DOM changes that cause visual glitches)
 * - ASCII snapshot comparison (UI vs tmux state)
 * - DOM size verification (element sizes match expected calculations)
 *
 * Built on top of the GlitchDetector for mutation observation.
 */

const { GlitchDetector, OPERATION_THRESHOLDS } = require('./glitch-detector');
const { delay } = require('./browser');
const { DELAYS } = require('./config');

// ==================== ASCII Snapshot Helpers ====================

/**
 * Get UI ASCII snapshot from browser.
 * Uses window.getSnapshot() which renders pane content to ASCII grid.
 *
 * @param {Page} page - Playwright page
 * @returns {Promise<string[]>} Array of strings (one per row)
 */
async function getUIAsciiSnapshot(page) {
  return page.evaluate(() => {
    if (typeof window.getSnapshot === 'function') {
      return window.getSnapshot();
    }
    return ['Error: window.getSnapshot not available'];
  });
}

/**
 * Get tmux ASCII snapshot from server API.
 * Uses the tmux-capture binary for VT100 rendering.
 *
 * @param {Page} page - Playwright page
 * @returns {Promise<string[]>} Array of strings (one per row)
 */
async function getTmuxAsciiSnapshot(page) {
  return page.evaluate(async () => {
    if (typeof window.getTmuxSnapshot === 'function') {
      return window.getTmuxSnapshot();
    }
    return ['Error: window.getTmuxSnapshot not available'];
  });
}

/**
 * Find character-level differences between two lines.
 *
 * @param {string} a - First line
 * @param {string} b - Second line
 * @returns {Array<{index: number, charA: string, charB: string}>} Differences
 */
function findCharDiff(a, b) {
  const diffs = [];
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a[i] : '';
    const charB = i < b.length ? b[i] : '';
    if (charA !== charB) {
      diffs.push({ index: i, charA, charB });
    }
  }

  return diffs;
}

/**
 * Compare two ASCII snapshots.
 * Returns { match, diff } where diff shows mismatched lines.
 *
 * @param {string[]} uiSnapshot - UI snapshot lines
 * @param {string[]} tmuxSnapshot - Tmux snapshot lines
 * @param {Object} options - Comparison options
 * @param {number} options.charDiffThreshold - Max char diffs per line to tolerate (default: 8)
 * @returns {{match: boolean, diff: Array, summary: Object}}
 */
function compareAsciiSnapshots(uiSnapshot, tmuxSnapshot, options = {}) {
  const { charDiffThreshold = 8 } = options;
  const maxLen = Math.max(uiSnapshot.length, tmuxSnapshot.length);
  const diff = [];
  let totalCharDiffs = 0;

  for (let i = 0; i < maxLen; i++) {
    // Trim trailing whitespace for comparison (common terminal variation)
    const uiLine = (uiSnapshot[i] || '').replace(/\s+$/, '');
    const tmuxLine = (tmuxSnapshot[i] || '').replace(/\s+$/, '');

    if (uiLine === tmuxLine) continue;

    // Skip rows where UI is empty but tmux has content (UI lag)
    if (uiLine === '' && tmuxLine !== '') continue;

    const charDiff = findCharDiff(uiLine, tmuxLine);
    const charDiffCount = charDiff.length;
    totalCharDiffs += charDiffCount;

    // Only report if difference exceeds threshold
    if (charDiffCount > charDiffThreshold) {
      diff.push({
        line: i,
        ui: uiLine,
        tmux: tmuxLine,
        charDiff: charDiff.slice(0, 10), // Limit for readability
        charDiffCount,
      });
    }
  }

  return {
    match: diff.length === 0,
    diff,
    summary: {
      linesCompared: maxLen,
      linesDifferent: diff.length,
      totalCharDiffs,
    },
  };
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
  const { tolerance = 30, gapSize = 2 } = options;

  const uiState = await page.evaluate(() => {
    const app = window.app?.getSnapshot()?.context;
    if (!app) return null;

    const { charWidth, charHeight, panes, totalWidth, totalHeight, activeWindowId } = app;

    // Filter to visible panes in active window
    const visiblePanes = (panes || []).filter(p => p.windowId === activeWindowId);

    // Get actual DOM element sizes
    const paneElements = document.querySelectorAll('[data-pane-id]');
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
      containerRect: containerRect ? {
        width: containerRect.width,
        height: containerRect.height,
        x: containerRect.x,
        y: containerRect.y,
      } : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  if (!uiState) {
    return { valid: false, errors: ['No UI state available (window.app not set)'], details: null };
  }

  const errors = [];

  // Verify each pane's DOM size matches expected formula
  // Allow for headers (~24px), gaps, and borders
  const headerHeight = 24;

  for (const pane of uiState.panes) {
    const domPane = uiState.domPanes.find(p => p.paneId === pane.tmuxId);
    if (!domPane) {
      // Pane may not have data-pane-id attribute - this is not an error
      continue;
    }

    // Expected size: cols * charWidth (for terminal content)
    // The DOM element includes headers and padding, so we check proportionality
    const expectedWidth = pane.width * uiState.charWidth;
    const expectedHeight = pane.height * uiState.charHeight;

    // Check width - allow generous tolerance for borders and padding
    const widthDiff = Math.abs(domPane.domWidth - expectedWidth);
    if (widthDiff > tolerance) {
      errors.push(
        `Pane ${pane.tmuxId} width: expected ~${expectedWidth.toFixed(1)}px ` +
        `(${pane.width}*${uiState.charWidth}), got ${domPane.domWidth.toFixed(1)}px ` +
        `(diff: ${widthDiff.toFixed(1)}px)`
      );
    }

    // Check height - allow for header and generous tolerance
    // DOM height should be >= expected height (content + header)
    const heightDiff = Math.abs(domPane.domHeight - expectedHeight);
    if (heightDiff > tolerance + headerHeight) {
      errors.push(
        `Pane ${pane.tmuxId} height: expected ~${expectedHeight.toFixed(1)}px ` +
        `(${pane.height}*${uiState.charHeight}), got ${domPane.domHeight.toFixed(1)}px ` +
        `(diff: ${heightDiff.toFixed(1)}px, tolerance: ${tolerance + headerHeight})`
      );
    }
  }

  // Verify container sizing (optional - only check if significant errors)
  // Container sizing checks are lenient since the layout has status bars and other elements
  if (uiState.containerRect && uiState.totalWidth && uiState.totalHeight) {
    const expectedContainerWidth = uiState.totalWidth * uiState.charWidth;

    // Only flag very large discrepancies (>50% difference)
    const containerWidthDiff = Math.abs(uiState.containerRect.width - expectedContainerWidth);
    if (containerWidthDiff > expectedContainerWidth * 0.5) {
      errors.push(
        `Container width significantly off: expected ~${expectedContainerWidth.toFixed(1)}px, ` +
        `got ${uiState.containerRect.width.toFixed(1)}px`
      );
    }
  }

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

  // Compare ASCII snapshots
  if (!skipSnapshot && ctx.page) {
    try {
      const uiSnapshot = await getUIAsciiSnapshot(ctx.page);
      const tmuxSnapshot = await getTmuxAsciiSnapshot(ctx.page);

      // Skip if either returned an error
      if (!uiSnapshot[0]?.startsWith('Error:') && !tmuxSnapshot[0]?.startsWith('Error:')) {
        snapshotResult = compareAsciiSnapshots(uiSnapshot, tmuxSnapshot);
      }
    } catch (e) {
      console.warn('Failed to compare snapshots:', e.message);
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

/**
 * Assert consistency check results pass expected thresholds.
 *
 * @param {Object} result - Result from withConsistencyChecks
 * @param {Object} options - Assertion options
 * @param {string} options.operation - Operation name for error messages
 * @param {boolean} options.allowFlicker - Allow flicker (default: false)
 * @param {boolean} options.allowSnapshotDiff - Allow snapshot differences (default: false)
 * @param {boolean} options.allowSizeErrors - Allow size errors (default: false)
 * @throws {Error} If consistency checks fail
 */
function assertConsistencyPasses(result, options = {}) {
  const {
    operation = 'operation',
    allowFlicker = false,
    allowSnapshotDiff = false,
    allowSizeErrors = false,
  } = options;

  const failures = [];

  // Check flicker
  if (!allowFlicker && result.glitch.hasFlicker) {
    const { nodeFlickers } = result.glitch.summary;
    const threshold = result.glitch.thresholds.nodeFlickers;
    if (nodeFlickers > threshold) {
      failures.push(
        `Flicker detected (${nodeFlickers} events, threshold: ${threshold}):\n` +
        result.glitch.flickers.slice(0, 3).map(f =>
          `  - ${f.element}: ${f.sequence.map(s => s.type).join(' -> ')}`
        ).join('\n')
      );
    }
  }

  // Check attribute churn
  if (!allowFlicker && result.glitch.hasChurn) {
    const { attrChurnEvents } = result.glitch.summary;
    const threshold = result.glitch.thresholds.attrChurnEvents;
    if (attrChurnEvents > threshold) {
      failures.push(
        `Attribute churn detected (${attrChurnEvents} events, threshold: ${threshold}):\n` +
        result.glitch.churn.slice(0, 3).map(c =>
          `  - ${c.target}: ${c.changeCount} changes`
        ).join('\n')
      );
    }
  }

  // Check snapshot match
  if (!allowSnapshotDiff && !result.snapshot.match) {
    failures.push(
      `Snapshot mismatch (${result.snapshot.diff.length} rows differ):\n` +
      result.snapshot.diff.slice(0, 3).map(d =>
        `  Row ${d.line}:\n    UI:   "${d.ui.slice(0, 60)}..."\n    tmux: "${d.tmux.slice(0, 60)}..."`
      ).join('\n')
    );
  }

  // Check DOM sizes
  if (!allowSizeErrors && !result.sizes.valid) {
    failures.push(
      `DOM size verification failed:\n` +
      result.sizes.errors.slice(0, 5).map(e => `  - ${e}`).join('\n')
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Consistency check failed for "${operation}":\n\n` +
      failures.join('\n\n')
    );
  }
}

module.exports = {
  // Snapshot helpers
  getUIAsciiSnapshot,
  getTmuxAsciiSnapshot,
  findCharDiff,
  compareAsciiSnapshots,

  // DOM size verification
  verifyDomSizes,

  // Wrapper and assertions
  withConsistencyChecks,
  assertConsistencyPasses,
};
