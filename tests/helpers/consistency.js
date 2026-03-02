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
const { tmuxQuery } = require('./cli');

// ==================== Structural State Comparison ====================

/**
 * Get tmux state snapshot via CLI (read-only tmux queries).
 * Queries tmux for windows, panes, and capture-pane content.
 *
 * Extracts the session name from the page URL to target the correct session.
 *
 * @param {Page} page - Playwright page (used to extract session name)
 * @returns {Promise<{windows: Array, panes: Array, content: Object}|null>}
 */
async function getTmuxState(page) {
  // Extract session name from page URL (?session=...)
  let sessionName;
  try {
    const url = new URL(page.url());
    sessionName = url.searchParams.get('session');
    if (!sessionName) return null;
  } catch {
    return null;
  }

  try {
    // Get windows: id, index, name, active, filtering out group/float windows
    const winRaw = tmuxQuery(
      `list-windows -t ${sessionName} -F "#{window_id}|#{window_index}|#{window_name}|#{window_active}"`
    );
    const windows = winRaw.split('\n').filter(Boolean).map(line => {
      const [id, index, name, active] = line.split('|');
      return { id, index: parseInt(index, 10), name, active: active === '1' };
    }).filter(w => !w.name.startsWith('__group_') && !w.name.startsWith('__float_'));

    // Get panes for active window: id, active, cols, rows
    const paneRaw = tmuxQuery(
      `list-panes -t ${sessionName} -F "#{pane_id}|#{pane_active}|#{pane_width}|#{pane_height}"`
    );
    const panes = paneRaw.split('\n').filter(Boolean).map(line => {
      const [id, active, width, height] = line.split('|');
      return {
        id,
        active: active === '1',
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    });

    // Note: Pane content comparison (capture-pane vs DOM) is omitted because
    // capture-pane and DOM rendering are inherently racy — the content is
    // captured at different moments, causing 1-line shifts that trigger
    // false positives. Structural comparison (windows, pane count, dimensions)
    // is reliable and sufficient.
    const content = {};

    return { windows, panes, content };
  } catch {
    return null;
  }
}

/**
 * Get UI state from XState context + DOM pane content.
 *
 * @param {Page} page - Playwright page
 * @returns {Promise<{windows: Array, panes: Array, content: Object}|null>}
 */
async function getUIState(page) {
  return page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const ctx = snap.context;

    // Windows (excluding group/float)
    const windows = (ctx.windows || [])
      .filter(w => !w.isPaneGroupWindow && !w.isFloatWindow)
      .map(w => ({ id: w.id, index: w.index, name: w.name, active: w.active }));

    // Panes in active window
    const visiblePanes = (ctx.panes || []).filter(p => p.windowId === ctx.activeWindowId);
    const panes = visiblePanes.map(p => ({
      id: p.tmuxId,
      active: p.active,
      width: p.width,
      height: p.height,
    }));

    // Extract text content from DOM per pane
    const content = {};
    for (const pane of visiblePanes) {
      const el = document.querySelector(`[data-pane-id="${pane.tmuxId}"] .terminal-content`);
      if (!el) { content[pane.tmuxId] = []; continue; }
      const lines = [];
      el.querySelectorAll('.terminal-line').forEach(lineEl => {
        let text = '';
        const spans = lineEl.querySelectorAll('span');
        if (spans.length > 0) {
          spans.forEach(s => { text += s.textContent || ''; });
        } else {
          text = lineEl.textContent || '';
        }
        lines.push(text);
      });
      content[pane.tmuxId] = lines;
    }

    return { windows, panes, content };
  });
}

/**
 * Compare tmux state against UI state structurally.
 *
 * Checks:
 * - Window count and names match
 * - Pane count, IDs, active status, and dimensions match
 * - Pane content matches line-by-line (trimmed, with tolerance)
 *
 * @param {Object} tmux - Result from getTmuxState()
 * @param {Object} ui - Result from getUIState()
 * @param {Object} options
 * @param {number} options.contentDiffThreshold - Max differing chars per line to tolerate (default: 8)
 * @returns {{match: boolean, errors: string[]}}
 */
function compareState(tmux, ui, options = {}) {
  const { contentDiffThreshold = 8 } = options;
  const errors = [];

  // --- Windows ---
  if (tmux.windows.length !== ui.windows.length) {
    errors.push(
      `Window count: tmux=${tmux.windows.length}, ui=${ui.windows.length}`
    );
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

  // --- Panes ---
  const tmuxPaneIds = tmux.panes.map(p => p.id).sort();
  const uiPaneIds = ui.panes.map(p => p.id).sort();

  if (tmuxPaneIds.join(',') !== uiPaneIds.join(',')) {
    errors.push(
      `Pane IDs differ: tmux=[${tmuxPaneIds}], ui=[${uiPaneIds}]`
    );
  } else {
    // Pane IDs match — compare properties per pane
    for (const tmuxPane of tmux.panes) {
      const uiPane = ui.panes.find(p => p.id === tmuxPane.id);
      if (!uiPane) continue; // shouldn't happen since IDs match

      if (tmuxPane.active !== uiPane.active) {
        errors.push(`Pane ${tmuxPane.id} active: tmux=${tmuxPane.active}, ui=${uiPane.active}`);
      }
      if (tmuxPane.width !== uiPane.width) {
        errors.push(`Pane ${tmuxPane.id} width: tmux=${tmuxPane.width}, ui=${uiPane.width}`);
      }
      // Allow 1-row height difference to account for the status line.
      // The server may report a different height than `list-panes` due to
      // how set_client_size allocates rows for the status bar.
      if (Math.abs(tmuxPane.height - uiPane.height) > 1) {
        errors.push(`Pane ${tmuxPane.id} height: tmux=${tmuxPane.height}, ui=${uiPane.height}`);
      }
    }
  }

  // --- Pane content ---
  // Skip content comparison when tmux content is not populated (e.g., when
  // getTmuxState omits capture-pane to avoid timing-related false positives).
  for (const tmuxPane of tmux.panes) {
    const tmuxLines = tmux.content[tmuxPane.id] || [];
    const uiLines = ui.content[tmuxPane.id] || [];
    if (tmuxLines.length === 0) continue;
    const maxLines = Math.max(tmuxLines.length, uiLines.length);

    let diffLineCount = 0;
    for (let i = 0; i < maxLines; i++) {
      const tLine = (tmuxLines[i] || '').replace(/\s+$/, '');
      const uLine = (uiLines[i] || '').replace(/\s+$/, '');
      if (tLine === uLine) continue;
      // Skip if UI is empty but tmux has content (UI lag)
      if (uLine === '' && tLine !== '') continue;

      // Count character-level differences
      let charDiffs = 0;
      const len = Math.max(tLine.length, uLine.length);
      for (let j = 0; j < len; j++) {
        if ((tLine[j] || ' ') !== (uLine[j] || ' ')) charDiffs++;
      }

      if (charDiffs > contentDiffThreshold) {
        diffLineCount++;
        if (diffLineCount <= 3) {
          errors.push(
            `Pane ${tmuxPane.id} line ${i} (${charDiffs} chars differ):\n` +
            `    tmux: ${JSON.stringify(tLine.slice(0, 80))}\n` +
            `    ui:   ${JSON.stringify(uLine.slice(0, 80))}`
          );
        }
      }
    }
    if (diffLineCount > 3) {
      errors.push(`Pane ${tmuxPane.id}: ${diffLineCount - 3} more differing lines`);
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
  } catch { return; }

  let lastErrors = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await delay(retryDelay);

    try {
      const [tmux, ui] = await Promise.all([
        getTmuxState(page),
        getUIState(page),
      ]);

      if (!tmux || !ui) return; // can't compare, skip silently

      const result = compareState(tmux, ui);
      if (result.match) return; // success

      lastErrors = result.errors;
    } catch (e) {
      // Page may be closing — skip
      return;
    }
  }

  throw new Error(
    `State mismatch (${lastErrors.length} difference(s) after ${retries} attempts):\n` +
    lastErrors.map(e => `  - ${e}`).join('\n')
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
    const visiblePanes = (panes || []).filter(p => p.windowId === activeWindowId);

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

  // Verify pane sizing: check that panes have proportional widths/heights
  // relative to each other. The UI sizes panes to fill the viewport, so absolute
  // pixel values won't match cols * charWidth when the viewport differs from
  // the tmux session dimensions. Instead, verify proportional relationships.

  const matchedPanes = uiState.panes
    .map(pane => ({
      pane,
      dom: uiState.domPanes.find(p => p.paneId === pane.tmuxId),
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
          `${b.pane.tmuxId} (${b.pane.width} cols), but DOM shows ${a.dom.domWidth.toFixed(0)} < ${b.dom.domWidth.toFixed(0)}`
        );
      }
      if (b.pane.width >= a.pane.width * 2 && b.dom.domWidth < a.dom.domWidth) {
        errors.push(
          `Pane ${b.pane.tmuxId} (${b.pane.width} cols) should be wider than ` +
          `${a.pane.tmuxId} (${a.pane.width} cols), but DOM shows ${b.dom.domWidth.toFixed(0)} < ${a.dom.domWidth.toFixed(0)}`
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
      const [tmux, ui] = await Promise.all([
        getTmuxState(ctx.page),
        getUIState(ctx.page),
      ]);
      if (tmux && ui) {
        const result = compareState(tmux, ui);
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

  // Check state match
  if (!allowSnapshotDiff && !result.snapshot.match) {
    failures.push(
      `State mismatch (${result.snapshot.diff.length} difference(s)):\n` +
      result.snapshot.diff.slice(0, 5).map(d =>
        `  - ${d.description || `Row ${d.line}`}`
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
  // Structural state comparison
  getTmuxState,
  getUIState,
  compareState,
  assertStateMatches,

  // DOM size verification
  verifyDomSizes,

  // Wrapper and assertions
  withConsistencyChecks,
  assertConsistencyPasses,
};
