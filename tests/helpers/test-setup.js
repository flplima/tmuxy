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
} = require('./browser');
const TmuxTestSession = require('./TmuxTestSession');
const { TMUXY_URL } = require('./config');

/**
 * Create test context with beforeAll/afterAll/beforeEach/afterEach
 *
 * Usage:
 * const ctx = createTestContext();
 * beforeAll(ctx.beforeAll);
 * afterAll(ctx.afterAll);
 * beforeEach(ctx.beforeEach);
 * afterEach(ctx.afterEach);
 *
 * Then use ctx.page, ctx.browser, ctx.session in tests
 */
function createTestContext() {
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
    return await navigateToSession(ctx.page, ctx.session.name);
  };

  /**
   * Setup page for test - navigate and focus
   * This is the most common test setup pattern
   */
  ctx.setupPage = async () => {
    await navigateToSession(ctx.page, ctx.session.name);
    await waitForSessionReady(ctx.page, ctx.session.name);
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
   * Uses tmux commands directly for reliability
   * @param {number} count - Number of panes to create (default: 3)
   */
  ctx.setupPanes = async (count = 3) => {
    // Create panes using tmux commands before navigating
    for (let i = 1; i < count; i++) {
      if (i % 2 === 0) {
        ctx.session.splitVertical();
      } else {
        ctx.session.splitHorizontal();
      }
    }
    await ctx.navigateToSession();
    await focusPage(ctx.page);
  };

  /**
   * Setup two panes with a single split
   * Uses tmux commands directly for reliability
   * @param {string} direction - 'horizontal' or 'vertical' (default: 'horizontal')
   */
  ctx.setupTwoPanes = async (direction = 'horizontal') => {
    // Create split using tmux command before navigating
    if (direction === 'horizontal') {
      ctx.session.splitHorizontal();
    } else {
      ctx.session.splitVertical();
    }
    await ctx.navigateToSession();
    await focusPage(ctx.page);
  };

  /**
   * Setup a 4-pane grid layout
   * Uses tmux commands directly for reliability
   */
  ctx.setupFourPanes = async () => {
    ctx.session.splitHorizontal();
    ctx.session.splitVertical();
    ctx.session.selectPane('U');
    ctx.session.splitVertical();
    await ctx.navigateToSession();
    await focusPage(ctx.page);
  };

  return ctx;
}

module.exports = {
  createTestContext,
};
