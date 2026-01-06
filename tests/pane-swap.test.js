/**
 * Pane Swap Tests
 *
 * Tests for swapping pane positions via keyboard and UI.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  getTmuxPaneInfo,
  getActiveTmuxPane,
  // UI
  splitPaneKeyboard,
  swapPaneKeyboard,
  navigatePaneKeyboard,
  // Assertions
  compareTmuxAndUIState,
} = require('./helpers');

const ctx = createTestContext();

describe('Pane Swap Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // Helper to set up two panes
  async function setupTwoPanes() {
    await ctx.navigateToSession();
    await focusPage(ctx.page);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    expect(getTmuxPaneCount(ctx.testSession)).toBe(2);
  }

  describe('Swap Down (Ctrl+a })', () => {
    test('swap pane with next pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes();

      // Navigate to first pane
      await navigatePaneKeyboard(ctx.page, 'up');

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before swap:', beforePanes.map(p => ({ id: p.id, index: p.index })));

      // Swap down
      await swapPaneKeyboard(ctx.page, 'down');

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      console.log('After swap:', afterPanes.map(p => ({ id: p.id, index: p.index })));

      // Panes should still exist
      expect(afterPanes.length).toBe(2);

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);
  });

  describe('Swap Up (Ctrl+a {)', () => {
    test('swap pane with previous pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes();

      // Stay on bottom pane (active after split)
      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before swap up:', beforePanes.map(p => ({ id: p.id, index: p.index })));

      // Swap up
      await swapPaneKeyboard(ctx.page, 'up');

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      console.log('After swap up:', afterPanes.map(p => ({ id: p.id, index: p.index })));

      // Panes should still exist
      expect(afterPanes.length).toBe(2);

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);
  });

  describe('Multiple Swaps', () => {
    test('swap panes back and forth', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes();
      await navigatePaneKeyboard(ctx.page, 'up');

      const initialPanes = getTmuxPaneInfo(ctx.testSession);

      // Swap down
      await swapPaneKeyboard(ctx.page, 'down');
      const afterDown = getTmuxPaneInfo(ctx.testSession);

      // Swap up to return to original
      await swapPaneKeyboard(ctx.page, 'up');
      const afterUp = getTmuxPaneInfo(ctx.testSession);

      // Should still have 2 panes
      expect(afterDown.length).toBe(2);
      expect(afterUp.length).toBe(2);

      console.log('Initial:', initialPanes.map(p => p.id));
      console.log('After down:', afterDown.map(p => p.id));
      console.log('After up:', afterUp.map(p => p.id));
    }, 45000);
  });

  describe('Swap in Complex Layout', () => {
    test('swap works with 3+ panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 3 panes
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(getTmuxPaneCount(ctx.testSession)).toBe(3);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('3 panes before swap:', beforePanes.map(p => p.id));

      // Swap
      await swapPaneKeyboard(ctx.page, 'down');

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      console.log('3 panes after swap:', afterPanes.map(p => p.id));

      // All panes should still exist
      expect(afterPanes.length).toBe(3);

      // Verify UI consistency
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);
  });
});
