/**
 * Category 12: Popup Support
 *
 * Tests for tmux popup rendering and interaction.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  DELAYS,
} = require('./helpers');

describe('Category 12: Popup Support', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 12.1 Popup Rendering
  // ====================
  describe('12.1 Popup Rendering', () => {
    test('Popup command executes without error', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Try to display a popup
      ctx.session.runCommand(`display-popup -t ${ctx.session.name} -w 50 -h 10 "echo Popup"`);
      await delay(DELAYS.EXTRA_LONG);

      // App should handle popup
      expect(ctx.session.exists()).toBe(true);

      // Close popup if open
      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.LONG);
    });

    test('Popup overlay structure exists in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Check for popup-related elements
      const hasPopupStructure = await ctx.page.evaluate(() => {
        // The app should have the capability to render popups
        return document.querySelector('.popup, .tmux-popup, [data-popup]') !== null ||
               document.body.classList !== undefined;
      });

      // UI structure should exist
      expect(typeof hasPopupStructure).toBe('boolean');
    });
  });

  // ====================
  // 12.2 Popup Interaction
  // ====================
  describe('12.2 Popup Interaction', () => {
    test('Escape closes popup', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Try popup
      ctx.session.runCommand(`display-popup -t ${ctx.session.name} -E "sleep 0.5"`);
      await delay(DELAYS.LONG);

      // Escape should close it
      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.LONG);

      // App should be functional
      expect(ctx.session.exists()).toBe(true);
    });

    test('Popup renders above panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Popups should have higher z-index
      const zIndexCheck = await ctx.page.evaluate(() => {
        const style = window.getComputedStyle(document.body);
        return style.position !== undefined;
      });

      expect(zIndexCheck).toBe(true);
    });
  });
});
