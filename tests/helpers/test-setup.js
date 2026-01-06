/**
 * Test Setup Utilities
 *
 * Shared setup/teardown for all test files
 */

const {
  getBrowser,
  waitForServer,
  isCdpAvailable,
  navigateToSession,
  delay,
} = require('./browser');
const {
  createTmuxSession,
  killTmuxSession,
  generateTestSessionName,
} = require('./tmux');
const { TMUXY_URL, CDP_PORT, DELAYS } = require('./config');

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
 * Then use ctx.page, ctx.browser, ctx.testSession in tests
 */
function createTestContext() {
  const ctx = {
    browser: null,
    page: null,
    testSession: null,
    wasConnected: false,
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
    console.log('Getting browser...');
    try {
      const cdpAvailable = await isCdpAvailable(CDP_PORT);
      ctx.wasConnected = cdpAvailable;
      ctx.browser = await getBrowser();
      console.log('Browser connected successfully');
    } catch (error) {
      console.error('Browser not available:', error.message);
      ctx.browserAvailable = false;
    }
  };

  ctx.afterAll = async () => {
    if (ctx.page) await ctx.page.close();
    if (ctx.browser && !ctx.wasConnected) {
      await ctx.browser.close();
    }
  };

  ctx.beforeEach = async () => {
    if (!ctx.browserAvailable || !ctx.browser) return;

    ctx.testSession = generateTestSessionName();
    console.log(`Creating test session: ${ctx.testSession}`);
    createTmuxSession(ctx.testSession);

    ctx.page = await ctx.browser.newPage();
  };

  ctx.afterEach = async () => {
    if (ctx.page) {
      await ctx.page.close();
      ctx.page = null;
    }

    if (ctx.testSession) {
      console.log(`Killing test session: ${ctx.testSession}`);
      killTmuxSession(ctx.testSession);
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
    return await navigateToSession(ctx.page, ctx.testSession);
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

  return ctx;
}

module.exports = {
  createTestContext,
};
