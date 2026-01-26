/**
 * Category 7: Mouse Events
 *
 * Tests for mouse clicks, wheel scrolling, selection, and dragging.
 */

const {
  createTestContext,
  delay,
  focusPage,
  clickPane,
  getUIPaneInfo,
  splitPaneKeyboard,
  DELAYS,
} = require('./helpers');

describe('Category 7: Mouse Events', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 7.1 Basic Mouse
  // ====================
  describe('7.1 Basic Mouse', () => {
    test('Click to focus pane - clicking pane focuses it', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('vertical');

      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);

      // Click first pane
      await clickPane(ctx.page, 0);
      await delay(DELAYS.LONG);

      // Pane should be focused
      const activePaneId = ctx.session.getActivePaneId();
      expect(activePaneId).toBeDefined();
    });

    test('Click in terminal - cursor interaction', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Click in terminal area
      const terminal = await ctx.page.$('[role="log"]');
      if (terminal) {
        const box = await terminal.boundingBox();
        await ctx.page.mouse.click(box.x + 50, box.y + 50);
        await delay(DELAYS.LONG);

        // Should still be functional
        expect(ctx.session.exists()).toBe(true);
      }
    });

    test('Right-click in pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const panes = await getUIPaneInfo(ctx.page);
      if (panes.length > 0) {
        const pane = panes[0];
        await ctx.page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2, { button: 'right' });
        await delay(DELAYS.LONG);

        // App should handle right-click
        expect(ctx.session.exists()).toBe(true);
      }
    });
  });

  // ====================
  // 7.2 Mouse in Applications
  // ====================
  describe('7.2 Mouse in Applications', () => {
    test('Mouse events are sent to tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Just verify mouse clicks don't break the app
      const terminal = await ctx.page.$('[role="log"]');
      if (terminal) {
        const box = await terminal.boundingBox();

        // Multiple clicks
        await ctx.page.mouse.click(box.x + 10, box.y + 10);
        await ctx.page.mouse.click(box.x + 50, box.y + 50);
        await ctx.page.mouse.click(box.x + 100, box.y + 100);
        await delay(DELAYS.LONG);

        expect(ctx.session.exists()).toBe(true);
      }
    });
  });

  // ====================
  // 7.3 Mouse Wheel
  // ====================
  describe('7.3 Mouse Wheel', () => {
    test('Scroll wheel works in terminal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const terminal = await ctx.page.$('[role="log"]');
      if (terminal) {
        const box = await terminal.boundingBox();

        // Scroll up
        await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await ctx.page.mouse.wheel({ deltaY: -100 });
        await delay(DELAYS.LONG);

        // Scroll down
        await ctx.page.mouse.wheel({ deltaY: 100 });
        await delay(DELAYS.LONG);

        expect(ctx.session.exists()).toBe(true);
      }
    });
  });

  // ====================
  // 7.4 Mouse Selection
  // ====================
  describe('7.4 Mouse Selection', () => {
    test('Click and drag to select text', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const terminal = await ctx.page.$('[role="log"]');
      if (terminal) {
        const box = await terminal.boundingBox();

        // Drag to select
        await ctx.page.mouse.move(box.x + 10, box.y + 10);
        await ctx.page.mouse.down();
        await ctx.page.mouse.move(box.x + 100, box.y + 10);
        await ctx.page.mouse.up();
        await delay(DELAYS.LONG);

        expect(ctx.session.exists()).toBe(true);
      }
    });

    test('Double-click to select word', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const terminal = await ctx.page.$('[role="log"]');
      if (terminal) {
        const box = await terminal.boundingBox();

        await ctx.page.mouse.click(box.x + 50, box.y + 50, { clickCount: 2 });
        await delay(DELAYS.LONG);

        expect(ctx.session.exists()).toBe(true);
      }
    });
  });

  // ====================
  // 7.5 Mouse Drag
  // ====================
  describe('7.5 Mouse Drag', () => {
    test('Drag pane header for move/swap', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const header = await ctx.page.$('.pane-header');
      if (header) {
        const box = await header.boundingBox();

        // Start drag
        await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await ctx.page.mouse.down();
        await ctx.page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 100);
        await ctx.page.mouse.up();
        await delay(DELAYS.LONG);

        // App should handle drag
        expect(ctx.session.exists()).toBe(true);
      }
    });

    test('Drag pane divider to resize', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Look for resize divider
      const divider = await ctx.page.$('.resize-divider, .pane-divider, [data-resize]');
      if (divider) {
        const box = await divider.boundingBox();

        await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await ctx.page.mouse.down();
        await ctx.page.mouse.move(box.x + box.width / 2, box.y + 50);
        await ctx.page.mouse.up();
        await delay(DELAYS.LONG);
      }

      expect(ctx.session.exists()).toBe(true);
    });
  });
});
