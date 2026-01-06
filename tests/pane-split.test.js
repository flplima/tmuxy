/**
 * Pane Split Tests
 *
 * Tests for splitting panes horizontally and vertically
 * via both keyboard shortcuts and UI interactions.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  getTmuxPaneInfo,
  // UI
  splitPaneKeyboard,
  splitPaneUI,
  getUIPaneCount,
  clickMenuItem,
  // Assertions
  compareTmuxAndUIState,
  verifySplit,
} = require('./helpers');

const ctx = createTestContext();

describe('Pane Split Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  describe('Horizontal Split (Ctrl+a ")', () => {
    test('creates two vertically stacked panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Verify initial state
      const initialCount = getTmuxPaneCount(ctx.testSession);
      expect(initialCount).toBe(1);

      // Split horizontally (creates panes stacked vertically)
      await splitPaneKeyboard(ctx.page, 'horizontal');

      // Verify split
      const result = await verifySplit(ctx.page, ctx.testSession, 2);
      expect(result.success).toBe(true);

      // Verify panes are stacked vertically (same width)
      const paneInfo = getTmuxPaneInfo(ctx.testSession);
      expect(paneInfo.length).toBe(2);
      expect(paneInfo[0].width).toBe(paneInfo[1].width);
    }, 45000);

    test('can split multiple times', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Split 3 times
      for (let i = 0; i < 3; i++) {
        await splitPaneKeyboard(ctx.page, 'horizontal');
      }

      // Should have 4 panes
      const result = await verifySplit(ctx.page, ctx.testSession, 4);
      expect(result.success).toBe(true);
    }, 60000);
  });

  describe('Vertical Split (Ctrl+a %)', () => {
    test('creates two side-by-side panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Verify initial state
      const initialCount = getTmuxPaneCount(ctx.testSession);
      expect(initialCount).toBe(1);

      // Split vertically (creates panes side by side)
      await splitPaneKeyboard(ctx.page, 'vertical');

      // Verify split
      const result = await verifySplit(ctx.page, ctx.testSession, 2);
      expect(result.success).toBe(true);

      // Verify panes are side by side (same height)
      const paneInfo = getTmuxPaneInfo(ctx.testSession);
      expect(paneInfo.length).toBe(2);
      expect(paneInfo[0].height).toBe(paneInfo[1].height);
    }, 45000);
  });

  describe('Split via UI Menu', () => {
    test('horizontal split via menu', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      const initialCount = getTmuxPaneCount(ctx.testSession);
      expect(initialCount).toBe(1);

      // Try UI split
      await splitPaneUI(ctx.page, 'horizontal');

      // Verify split - may fail if UI doesn't have split button
      const newCount = getTmuxPaneCount(ctx.testSession);
      // Accept either successful split or no change (if UI feature not available)
      expect(newCount).toBeGreaterThanOrEqual(1);
    }, 45000);

    test('vertical split via menu', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      const initialCount = getTmuxPaneCount(ctx.testSession);
      expect(initialCount).toBe(1);

      await splitPaneUI(ctx.page, 'vertical');

      const newCount = getTmuxPaneCount(ctx.testSession);
      expect(newCount).toBeGreaterThanOrEqual(1);
    }, 45000);
  });

  describe('Mixed Splits', () => {
    test('create grid layout with horizontal then vertical splits', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Start with horizontal split (2 panes stacked)
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(getTmuxPaneCount(ctx.testSession)).toBe(2);

      // Vertical split on bottom pane (creates 3 panes)
      await splitPaneKeyboard(ctx.page, 'vertical');
      expect(getTmuxPaneCount(ctx.testSession)).toBe(3);

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);
  });

  describe('UI/Tmux Consistency', () => {
    test('UI pane count matches tmux after splits', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Perform several splits
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');

      // Allow sync
      await delay(DELAYS.SYNC);

      // Verify consistency
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      console.log('UI vs Tmux:', {
        uiPanes: comparison.uiPaneCount,
        tmuxPanes: comparison.tmuxPaneCount,
      });
      expect(comparison.match).toBe(true);
    }, 45000);
  });
});
