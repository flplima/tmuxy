/**
 * Category 13: Performance & Stress
 *
 * Tests for output performance, layout performance, and long sessions.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  getUIPaneCount,
  DELAYS,
} = require('./helpers');

describe('Category 13: Performance & Stress', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 13.1 Output Performance
  // ====================
  describe('13.1 Output Performance', () => {
    test('Rapid output - yes | head -1000', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const start = Date.now();

      await typeInTerminal(ctx.page, 'yes | head -1000');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG * 2);

      const elapsed = Date.now() - start;

      // Should complete without hanging
      expect(elapsed).toBeLessThan(30000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Large file cat - seq 1 5000', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const start = Date.now();

      await typeInTerminal(ctx.page, 'seq 1 5000');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG * 3);

      const elapsed = Date.now() - start;

      // Should complete reasonably fast
      expect(elapsed).toBeLessThan(60000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Continuous output - ping', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Start continuous output
      await typeInTerminal(ctx.page, 'ping -c 5 127.0.0.1');
      await pressEnter(ctx.page);

      // Wait for it to run
      await delay(DELAYS.EXTRA_LONG * 6);

      // Should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 13.2 Layout Performance
  // ====================
  describe('13.2 Layout Performance', () => {
    test('Many panes - create 8 panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 8 panes
      for (let i = 0; i < 7; i++) {
        await splitPaneKeyboard(ctx.page, i % 2 === 0 ? 'horizontal' : 'vertical');
      }

      expect(ctx.session.getPaneCount()).toBe(8);

      // UI should show all panes
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(8);
    });

    test('Rapid split/close', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Rapid operations
      for (let i = 0; i < 3; i++) {
        await splitPaneKeyboard(ctx.page, 'horizontal');
        await delay(DELAYS.LONG);
      }

      expect(ctx.session.getPaneCount()).toBe(4);

      // Close them
      for (let i = 0; i < 3; i++) {
        await typeInTerminal(ctx.page, 'exit');
        await pressEnter(ctx.page);
        await delay(DELAYS.LONG);
      }

      expect(ctx.session.getPaneCount()).toBe(1);
    });

    test('Resize during output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Start output in background
      ctx.session.runCommand(`send-keys -t ${ctx.session.name} "seq 1 100; sleep 0.1" Enter`);

      // Resize while output is happening
      ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
      await delay(DELAYS.LONG);
      ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -U 3`);
      await delay(DELAYS.LONG);

      // Should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 13.3 Long Sessions
  // ====================
  describe('13.3 Long Sessions', () => {
    test('Large scrollback - accumulate history', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Generate lots of output
      await typeInTerminal(ctx.page, 'seq 1 500');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG * 2);

      // Should have scrollback
      expect(ctx.session.exists()).toBe(true);
    });

    test('Many windows - create 5 windows', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      for (let i = 0; i < 5; i++) {
        ctx.session.runCommand(`new-window -t ${ctx.session.name}`);
        await delay(DELAYS.LONG);
      }

      expect(ctx.session.getWindowCount()).toBe(6);

      // UI should show all window tabs
      const windowTabs = await ctx.page.$$('.window-tab');
      expect(windowTabs.length).toBeGreaterThanOrEqual(6);
    });
  });
});
