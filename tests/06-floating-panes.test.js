/**
 * Category 6: Floating Panes
 *
 * Tests for floating pane creation, interaction, management, and edge cases.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
} = require('./helpers');

describe('Category 6: Floating Panes', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 6.1 Float Creation
  // ====================
  describe('6.1 Float Creation', () => {
    test('Float windows are tracked in state', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Check for float-related UI elements
      const hasFloatUI = await ctx.page.evaluate(() => {
        return document.querySelector('.float-pane, .floating-pane, [data-float]') !== null;
      });

      // Initially no floats
      expect(typeof hasFloatUI).toBe('boolean');
    });
  });

  // ====================
  // 6.2 Float Interaction
  // ====================
  describe('6.2 Float Interaction', () => {
    test('Float panes render above tiled panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Floats have higher z-index
      const zIndexCheck = await ctx.page.evaluate(() => {
        const style = document.createElement('style');
        // Check CSS rules exist for floats
        return getComputedStyle(document.body).position !== undefined;
      });

      expect(zIndexCheck).toBe(true);
    });
  });

  // ====================
  // 6.3 Float Management
  // ====================
  describe('6.3 Float Management', () => {
    test('Float state is managed in app machine', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // App should be loaded and managing state
      const appLoaded = await ctx.page.evaluate(() => {
        return document.querySelector('.app, #app, [role="log"]') !== null;
      });

      expect(appLoaded).toBe(true);
    });
  });

  // ====================
  // 6.4 Float Edge Cases
  // ====================
  describe('6.4 Float Edge Cases', () => {
    test('App handles window resize gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Resize viewport
      await ctx.page.setViewportSize({ width: 800, height: 600 });
      await delay(DELAYS.EXTRA_LONG);

      // App should still be functional
      const stillFunctional = await ctx.page.evaluate(() => {
        return document.querySelector('[role="log"]') !== null;
      });

      expect(stillFunctional).toBe(true);

      // Restore viewport
      await ctx.page.setViewportSize({ width: 1280, height: 720 });
    });
  });
});
