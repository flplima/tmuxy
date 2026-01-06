/**
 * Pane Close Tests
 *
 * Tests for closing/killing panes via keyboard and UI.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  getActiveTmuxPane,
  // UI
  splitPaneKeyboard,
  killPaneKeyboard,
  navigatePaneKeyboard,
  // Assertions
  compareTmuxAndUIState,
} = require('./helpers');

const ctx = createTestContext();

describe('Pane Close Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // Helper to set up multiple panes
  async function setupMultiplePanes(count = 2) {
    await ctx.navigateToSession();
    await focusPage(ctx.page);

    for (let i = 1; i < count; i++) {
      await splitPaneKeyboard(ctx.page, i % 2 === 0 ? 'vertical' : 'horizontal');
    }
    expect(getTmuxPaneCount(ctx.testSession)).toBe(count);
  }

  describe('Kill Pane (Ctrl+a x)', () => {
    test('kill pane with confirmation', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(2);

      const initialCount = getTmuxPaneCount(ctx.testSession);
      console.log('Initial panes:', initialCount);

      // Kill the active pane (Ctrl+a x, then y to confirm)
      await killPaneKeyboard(ctx.page);

      const finalCount = getTmuxPaneCount(ctx.testSession);
      console.log('Panes after kill:', finalCount);

      expect(finalCount).toBe(initialCount - 1);
    }, 45000);

    test('kill specific pane in multi-pane layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(3);

      const initialCount = getTmuxPaneCount(ctx.testSession);
      console.log('Initial panes:', initialCount);

      // Navigate to first pane
      await navigatePaneKeyboard(ctx.page, 'up');
      await navigatePaneKeyboard(ctx.page, 'up');

      const beforeKill = getActiveTmuxPane(ctx.testSession);
      console.log('About to kill pane:', beforeKill);

      // Kill this pane
      await killPaneKeyboard(ctx.page);

      const afterCount = getTmuxPaneCount(ctx.testSession);
      console.log('Panes after kill:', afterCount);

      expect(afterCount).toBe(initialCount - 1);

      // Verify UI matches
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);

    test('kill multiple panes sequentially', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(4);

      let currentCount = getTmuxPaneCount(ctx.testSession);
      expect(currentCount).toBe(4);

      // Kill 2 panes
      for (let i = 0; i < 2; i++) {
        await killPaneKeyboard(ctx.page);
        currentCount = getTmuxPaneCount(ctx.testSession);
        console.log(`After kill ${i + 1}:`, currentCount);
      }

      expect(currentCount).toBe(2);
    }, 60000);
  });

  describe('Close via UI Button', () => {
    test('close pane via close button', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(2);

      const initialCount = getTmuxPaneCount(ctx.testSession);

      // Find and click close button
      const closeBtn = await ctx.page.$('.pane-close');

      if (closeBtn) {
        await closeBtn.click();
        await delay(DELAYS.EXTRA_LONG);

        const finalCount = getTmuxPaneCount(ctx.testSession);
        console.log('Panes after close button:', finalCount);
        expect(finalCount).toBe(initialCount - 1);
      } else {
        console.log('No close button found - UI may not have this feature');
      }
    }, 45000);

    test('close button works on different panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(3);

      const initialCount = getTmuxPaneCount(ctx.testSession);

      // Find all close buttons
      const closeButtons = await ctx.page.$$('.pane-close');
      console.log('Found close buttons:', closeButtons.length);

      if (closeButtons.length >= 2) {
        // Click the second close button
        await closeButtons[1].click();
        await delay(DELAYS.EXTRA_LONG);

        const finalCount = getTmuxPaneCount(ctx.testSession);
        console.log('Panes after closing second:', finalCount);
        expect(finalCount).toBe(initialCount - 1);
      }
    }, 45000);
  });

  describe('Close Last Pane Behavior', () => {
    test('closing last pane in window closes window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const { createWindowKeyboard, getTmuxWindowCount } = require('./helpers');

      // Create a second window
      await createWindowKeyboard(ctx.page);
      expect(getTmuxWindowCount(ctx.testSession)).toBe(2);

      // Kill the only pane in window 1
      await killPaneKeyboard(ctx.page);

      // Should have only 1 window now
      const windowCount = getTmuxWindowCount(ctx.testSession);
      console.log('Windows after killing last pane:', windowCount);
      expect(windowCount).toBe(1);
    }, 45000);
  });

  describe('UI State After Close', () => {
    test('UI updates after pane close', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(3);
      await delay(DELAYS.SYNC);

      const { getUIPaneCount } = require('./helpers');

      const initialUI = await getUIPaneCount(ctx.page);
      console.log('Initial UI panes:', initialUI);

      // Close a pane
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.SYNC);

      const finalUI = await getUIPaneCount(ctx.page);
      console.log('Final UI panes:', finalUI);

      expect(finalUI).toBe(initialUI - 1);

      // Verify consistency
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);

    test('focus moves to remaining pane after close', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(2);

      const beforeKill = getActiveTmuxPane(ctx.testSession);
      console.log('Active pane before kill:', beforeKill);

      // Kill the active pane
      await killPaneKeyboard(ctx.page);

      const afterKill = getActiveTmuxPane(ctx.testSession);
      console.log('Active pane after kill:', afterKill);

      // Should have a different active pane now
      expect(afterKill).not.toBe(beforeKill);
      expect(getTmuxPaneCount(ctx.testSession)).toBe(1);
    }, 45000);
  });

  describe('Cancel Kill Operation', () => {
    test('cancel kill with n', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupMultiplePanes(2);

      const initialCount = getTmuxPaneCount(ctx.testSession);

      // Start kill, but cancel with 'n'
      const { sendTmuxPrefix } = require('./helpers');
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('x');
      await delay(DELAYS.LONG);
      await ctx.page.keyboard.press('n'); // Cancel
      await delay(DELAYS.LONG);

      const finalCount = getTmuxPaneCount(ctx.testSession);
      console.log('Panes after cancel:', finalCount);

      // Count should remain the same
      expect(finalCount).toBe(initialCount);
    }, 45000);
  });
});
