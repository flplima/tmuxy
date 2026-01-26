/**
 * Category 10: Session & Connection
 *
 * Tests for session management, reconnection, multi-client, and flow control.
 */

const {
  createTestContext,
  delay,
  focusPage,
  splitPaneKeyboard,
  createWindowKeyboard,
  DELAYS,
} = require('./helpers');

describe('Category 10: Session & Connection', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 10.1 Session Management
  // ====================
  describe('10.1 Session Management', () => {
    test('Session persists after page reload', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create some state
      await splitPaneKeyboard(ctx.page, 'horizontal');
      const paneCountBefore = ctx.session.getPaneCount();

      // Reload page
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.EXTRA_LONG);

      // State should persist
      const paneCountAfter = ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);
    });

    test('Multiple windows survive refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      await createWindowKeyboard(ctx.page);
      const windowCountBefore = ctx.session.getWindowCount();

      // Reload
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.EXTRA_LONG);

      const windowCountAfter = ctx.session.getWindowCount();
      expect(windowCountAfter).toBe(windowCountBefore);
    });

    test('Complex pane layout survives refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();
      const paneCountBefore = ctx.session.getPaneCount();

      // Reload
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.EXTRA_LONG);

      const paneCountAfter = ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);
    });
  });

  // ====================
  // 10.2 Reconnection
  // ====================
  describe('10.2 Reconnection', () => {
    test('WebSocket connection established', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      // Page should load and connect
      const terminal = await ctx.page.$('[role="log"]');
      expect(terminal).not.toBeNull();
    });

    test('State is restored after reconnect', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await splitPaneKeyboard(ctx.page, 'horizontal');

      // Navigate away and back (simulates reconnect)
      await ctx.page.goto('about:blank');
      await delay(DELAYS.LONG);

      await ctx.navigateToSession();
      await delay(DELAYS.EXTRA_LONG);

      // State should be restored
      expect(ctx.session.getPaneCount()).toBe(2);
    });
  });

  // ====================
  // 10.3 Multi-Client
  // ====================
  describe('10.3 Multi-Client', () => {
    test('Multiple pages can connect to same session', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      // Open second page to same session
      const page2 = await ctx.browser.newPage();
      try {
        await page2.goto(`http://localhost:3853?session=${ctx.session.name}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page2.waitForSelector('[role="log"]', { timeout: 10000 });

        // Both should see the terminal
        const terminal1 = await ctx.page.$('[role="log"]');
        const terminal2 = await page2.$('[role="log"]');

        expect(terminal1).not.toBeNull();
        expect(terminal2).not.toBeNull();
      } finally {
        await page2.close();
      }
    });
  });

  // ====================
  // 10.4 Flow Control
  // ====================
  describe('10.4 Flow Control', () => {
    test('App handles rapid output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Generate rapid output
      ctx.session.runCommand(`send-keys -t ${ctx.session.name} "yes | head -1000" Enter`);
      await delay(DELAYS.EXTRA_LONG * 3);

      // App should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });
});
