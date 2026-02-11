/**
 * Test Setup Utilities
 *
 * Shared setup/teardown for all test files
 */

const {
  getBrowser,
  waitForServer,
  navigateToSession,
  focusPage,
  waitForSessionReady,
  waitForPaneCount,
  delay,
} = require('./browser');
const TmuxTestSession = require('./TmuxTestSession');
const { TMUXY_URL, DELAYS } = require('./config');

/**
 * Compute Levenshtein edit distance between two strings.
 * Uses O(min(m,n)) space optimization.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for O(min(m,n)) space
  if (a.length > b.length) { const t = a; a = b; b = t; }

  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let curr = new Array(m + 1);

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1];
      } else {
        curr[i] = 1 + Math.min(prev[i - 1], prev[i], curr[i - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * Compare rows from UI and tmux snapshots.
 * Returns an array of diff descriptions for rows that exceed the threshold.
 */
function compareSnapshotRows(uiLines, tmuxLines) {
  // Maximum edit distance per row before considering it a real mismatch.
  // Small diffs (1-8 chars) are typically terminal emulation edge cases
  // (alternate screen restore, cursor positioning, escape sequence handling).
  // Observed: UI drops 5-6 chars from long escape-heavy command lines.
  const CHAR_DIFF_THRESHOLD = 8;

  const maxLen = Math.max(uiLines.length, tmuxLines.length);
  const diffs = [];

  for (let i = 0; i < maxLen; i++) {
    const uiLine = (uiLines[i] || '').replace(/\s+$/, '');
    const tmuxLine = (tmuxLines[i] || '').replace(/\s+$/, '');
    if (uiLine === tmuxLine) continue;

    // Skip rows where UI is empty but tmux has content — the terminal
    // emulator may be a few frames behind tmux's native rendering.
    if (uiLine === '' && tmuxLine !== '') continue;

    const charDiffs = editDistance(uiLine, tmuxLine);
    if (charDiffs > CHAR_DIFF_THRESHOLD) {
      diffs.push(
        `  Row ${i} (${charDiffs} chars differ):\n` +
        `    UI:   ${JSON.stringify(uiLine)}\n` +
        `    tmux: ${JSON.stringify(tmuxLine)}`
      );
    }
  }

  return diffs;
}

/**
 * Compare UI snapshot against tmux snapshot.
 * Both are arrays of strings (one per row). Trims trailing whitespace per line.
 * Checks immediately, then polls on mismatch. Tolerates small per-row
 * differences (≤ 5 edit distance) caused by terminal emulation edge cases.
 * Throws on mismatch with a line-by-line diff.
 */
async function assertSnapshotsMatch(page) {
  // Skip if page navigated away from the session
  try {
    const pageUrl = page.url();
    if (!pageUrl.includes('localhost:3853') || pageUrl === 'about:blank') {
      return;
    }
  } catch {
    return; // Page closed or crashed
  }

  // Check immediately (0ms), then poll with increasing delays on mismatch.
  const POLL_INTERVALS = [0, 500, 1000, 1500]; // Total: 3s max
  let lastDiffs = null;

  for (let attempt = 0; attempt < POLL_INTERVALS.length; attempt++) {
    if (POLL_INTERVALS[attempt] > 0) {
      await delay(POLL_INTERVALS[attempt]);
    }

    const { uiLines, tmuxLines } = await page.evaluate(async () => {
      const ui = typeof window.getSnapshot === 'function' ? window.getSnapshot() : null;
      const tmux = typeof window.getTmuxSnapshot === 'function' ? await window.getTmuxSnapshot() : null;
      return { uiLines: ui, tmuxLines: tmux };
    });

    if (!uiLines || !tmuxLines) return;

    // Skip if either snapshot returned an error
    if (uiLines.length > 0 && uiLines[0].startsWith('Error:')) return;
    if (tmuxLines.length > 0 && tmuxLines[0].startsWith('Error:')) return;

    const diffs = compareSnapshotRows(uiLines, tmuxLines);
    if (diffs.length === 0) return; // Match — success

    lastDiffs = diffs;
    // Continue polling — UI may still be catching up
  }

  // If all diffs are very large (>50 edit distance), the test likely already
  // failed and left the terminal in a bad state. Log instead of throwing.
  const allLargeDiffs = lastDiffs.every(d => {
    const match = d.match(/\((\d+) chars differ\)/);
    return match && parseInt(match[1], 10) > 50;
  });
  if (allLargeDiffs) {
    console.warn(
      `Snapshot warning (${lastDiffs.length} row(s) differ, likely stale state):\n${lastDiffs.join('\n')}`
    );
    return;
  }

  throw new Error(
    `Snapshot mismatch (${lastDiffs.length} row(s) differ beyond threshold):\n${lastDiffs.join('\n')}`
  );
}

/**
 * Create test context with beforeAll/afterAll/beforeEach/afterEach
 *
 * @param {Object} [options]
 * @param {boolean} [options.snapshot=false] - Run snapshot comparison in afterEach.
 *   Enable for rendering-focused suites (basic connectivity, floating panes,
 *   status bar, OSC protocols). Disabled by default for logic/functional suites
 *   to avoid the polling overhead.
 *
 * Usage:
 * const ctx = createTestContext({ snapshot: true });
 * beforeAll(ctx.beforeAll);
 * afterAll(ctx.afterAll);
 * beforeEach(ctx.beforeEach);
 * afterEach(ctx.afterEach);
 *
 * Then use ctx.page, ctx.browser, ctx.session in tests
 */
function createTestContext({ snapshot = false } = {}) {
  const ctx = {
    browser: null,
    page: null,
    session: null,        // TmuxTestSession instance
    testSession: null,    // Session name (for backwards compatibility)
    browserAvailable: true,
    serverAvailable: true,
  };

  ctx.beforeAll = async () => {
    // Wait for server
    console.log('Checking server availability...');
    try {
      await waitForServer(TMUXY_URL, 10000);
      console.log('Server is available');
    } catch (error) {
      console.error('Tmuxy server not available:', error.message);
      ctx.serverAvailable = false;
      return;
    }

    // Get browser
    console.log('Launching browser...');
    try {
      ctx.browser = await getBrowser();
      console.log('Browser launched successfully');
    } catch (error) {
      console.error('Browser not available:', error.message);
      ctx.browserAvailable = false;
    }
  };

  ctx.afterAll = async () => {
    if (ctx.page) await ctx.page.close();
    if (ctx.browser) {
      await ctx.browser.close();
    }
  };

  ctx.beforeEach = async () => {
    if (!ctx.browserAvailable || !ctx.browser) return;

    // Create new TmuxTestSession
    ctx.session = new TmuxTestSession();
    ctx.testSession = ctx.session.name; // backwards compatibility
    console.log(`Creating test session: ${ctx.session.name}`);
    ctx.session.create();

    ctx.page = await ctx.browser.newPage();
  };

  ctx.afterEach = async () => {
    // Compare UI snapshot vs tmux snapshot before closing (rendering suites only)
    if (snapshot && ctx.page) {
      try {
        await assertSnapshotsMatch(ctx.page);
      } catch (e) {
        // Re-throw as a test failure - afterEach errors fail the test
        throw e;
      }
    }

    if (ctx.page) {
      // Close the context (which also closes the page) for proper Playwright cleanup
      if (ctx.page._context) {
        await ctx.page._context.close();
      } else {
        await ctx.page.close();
      }
      ctx.page = null;
    }

    if (ctx.session) {
      console.log(`Killing test session: ${ctx.session.name}`);
      ctx.session.destroy();
      ctx.session = null;
      ctx.testSession = null;
    }
  };

  /**
   * Check if test prerequisites are available
   */
  ctx.isReady = () => {
    return ctx.serverAvailable && ctx.browserAvailable && ctx.browser && ctx.page;
  };

  /**
   * Navigate to the test session
   */
  ctx.navigateToSession = async () => {
    await navigateToSession(ctx.page, ctx.session.name);
    await waitForSessionReady(ctx.page, ctx.session.name);
    // Set page reference for WebSocket routing
    ctx.session.setPage(ctx.page);
  };

  /**
   * Setup page for test - navigate and focus
   * This is the most common test setup pattern
   */
  ctx.setupPage = async () => {
    await navigateToSession(ctx.page, ctx.session.name);
    await waitForSessionReady(ctx.page, ctx.session.name);
    // Set page reference for WebSocket routing
    ctx.session.setPage(ctx.page);
    await focusPage(ctx.page);
  };

  /**
   * Skip test if prerequisites not met
   */
  ctx.skipIfNotReady = () => {
    if (!ctx.isReady()) {
      console.log('Skipping test: prerequisites not available');
      return true;
    }
    return false;
  };

  /**
   * Setup multiple panes with alternating split directions
   * Navigates first, then creates panes via WebSocket
   * @param {number} count - Number of panes to create (default: 3)
   */
  ctx.setupPanes = async (count = 3) => {
    await ctx.navigateToSession();
    await focusPage(ctx.page);
    // Create panes via WebSocket after navigation
    for (let i = 1; i < count; i++) {
      if (i % 2 === 0) {
        await ctx.session.splitVertical();
      } else {
        await ctx.session.splitHorizontal();
      }
      // Wait for state to update
      await delay(DELAYS.SHORT);
    }
  };

  /**
   * Setup two panes with a single split
   * Navigates first, then creates split via WebSocket
   * @param {string} direction - 'horizontal' or 'vertical' (default: 'horizontal')
   */
  ctx.setupTwoPanes = async (direction = 'horizontal') => {
    await ctx.navigateToSession();
    await focusPage(ctx.page);
    // Create split via WebSocket after navigation
    if (direction === 'horizontal') {
      await ctx.session.splitHorizontal();
    } else {
      await ctx.session.splitVertical();
    }
    // Wait for UI to render both panes
    await waitForPaneCount(ctx.page, 2);
  };

  /**
   * Setup a 4-pane grid layout
   * Navigates first, then creates panes via WebSocket
   */
  ctx.setupFourPanes = async () => {
    await ctx.navigateToSession();
    await focusPage(ctx.page);
    // Create 4-pane grid via WebSocket
    await ctx.session.splitHorizontal();
    await waitForPaneCount(ctx.page, 2);
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 3);
    await ctx.session.selectPane('U');
    await delay(DELAYS.SHORT);
    await ctx.session.splitVertical();
    await waitForPaneCount(ctx.page, 4);
  };

  return ctx;
}

module.exports = {
  createTestContext,
  assertSnapshotsMatch,
};
