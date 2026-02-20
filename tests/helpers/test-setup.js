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
const { GlitchDetector } = require('./glitch-detector');
const { assertStateMatches } = require('./consistency');

/**
 * Create test context with beforeAll/afterAll/beforeEach/afterEach
 *
 * @param {Object} [options]
 * @param {boolean} [options.snapshot=false] - Run snapshot comparison in afterEach.
 *   Enable for rendering-focused suites (basic connectivity, floating panes,
 *   status bar, OSC protocols). Disabled by default for logic/functional suites
 *   to avoid the polling overhead.
 * @param {boolean} [options.glitchDetection=false] - Enable glitch detection in afterEach.
 *   When enabled, afterEach will assert no glitches were detected during the test.
 *   Can also be used manually via ctx.glitchDetector.
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
function createTestContext({ snapshot = false, glitchDetection = false } = {}) {
  const ctx = {
    browser: null,
    page: null,
    session: null,        // TmuxTestSession instance
    testSession: null,    // Session name (for backwards compatibility)
    browserAvailable: true,
    serverAvailable: true,
    glitchDetector: null, // GlitchDetector instance (when glitchDetection enabled)
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
    if (ctx.page) await ctx.page.close().catch(() => {});
    // Don't close browser — shared CDP connection must persist across suites
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
    // Capture assertion errors but ALWAYS run cleanup afterward.
    // If cleanup is skipped (e.g., snapshot check throws), the control mode
    // connection stays attached and the next test's `tmux new-session` crashes tmux 3.5a.
    let assertionError = null;

    // Compare structural state: tmux windows/panes/content vs UI (rendering suites only)
    if (snapshot && ctx.page) {
      try {
        await assertStateMatches(ctx.page);
      } catch (e) {
        assertionError = e;
      }
    }

    // Check for glitches if detector was started (manual or automatic)
    if (ctx.glitchDetector?.isRunning) {
      try {
        await ctx.glitchDetector.assertNoGlitches({ operation: 'test' });
      } catch (e) {
        if (!assertionError) assertionError = e;
      } finally {
        ctx.glitchDetector = null;
      }
    }

    // Always close page and destroy session, even if assertions failed above.
    // IMPORTANT: Kill session through adapter BEFORE closing the page.
    // This routes kill-session through control mode (safe), avoiding the
    // tmux 3.5a crash that occurs with external commands while control mode is attached.
    if (ctx.session?.page && ctx.session.created) {
      try {
        await ctx.session.destroyViaAdapter();
      } catch {
        // Adapter not available — will fall through to execSync below
      }
    }

    if (ctx.page) {
      await ctx.page.close().catch(() => {});
      ctx.page = null;
    }

    if (ctx.session) {
      if (ctx.session.created) {
        // Fallback: if adapter-based destroy didn't work, wait for control mode
        // disconnect and use execSync. SSE keepalive is 1s, cleanup ~600ms.
        await delay(2000);
        console.log(`Killing test session: ${ctx.session.name}`);
        ctx.session.destroy();
      }
      ctx.session = null;
      ctx.testSession = null;
    }

    // Re-throw after cleanup so the test still fails
    if (assertionError) throw assertionError;
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

    // Auto-start glitch detection if enabled
    if (glitchDetection) {
      ctx.glitchDetector = new GlitchDetector(ctx.page);
      await ctx.glitchDetector.start();
    }
  };

  /**
   * Start glitch detection manually (for targeted tests)
   * @param {Object} options - GlitchDetector options
   */
  ctx.startGlitchDetection = async (options = {}) => {
    if (!ctx.page) {
      throw new Error('Page not available. Call setupPage() first.');
    }
    ctx.glitchDetector = new GlitchDetector(ctx.page);
    await ctx.glitchDetector.start(options);
    return ctx.glitchDetector;
  };

  /**
   * Stop glitch detection and assert no glitches
   * @param {Object} options - Assertion options (operation, thresholds)
   */
  ctx.assertNoGlitches = async (options = {}) => {
    if (!ctx.glitchDetector) {
      throw new Error('GlitchDetector not started. Call startGlitchDetection() first.');
    }
    const result = await ctx.glitchDetector.assertNoGlitches(options);
    ctx.glitchDetector = null;
    return result;
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
  assertSnapshotsMatch: assertStateMatches,
};
