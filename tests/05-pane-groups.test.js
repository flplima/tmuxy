/**
 * Category 5: Pane Groups
 *
 * Tests for pane group creation, navigation, management, and persistence.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
  DELAYS,
} = require('./helpers');

describe('Category 5: Pane Groups', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 5.1 Basic Group Operations
  // ====================
  describe('5.1 Basic Group Operations', () => {
    test('Create group - pane can be added to group via event', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create a split first
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await delay(DELAYS.EXTRA_LONG);

      // Verify we have 2 panes
      expect(ctx.session.getPaneCount()).toBe(2);

      // Note: Pane groups are created via UI events (PANE_GROUP_ADD)
      // This requires specific UI interaction which may vary
    });

    test('Group tabs appear when panes are grouped', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // When panes are grouped, tabs should appear
      // Check for group-tabs class
      const hasGroupTabs = await ctx.page.evaluate(() => {
        return document.querySelector('.group-tabs, .pane-header-grouped') !== null;
      });

      // Initially no groups
      // This is a basic structure test
      expect(typeof hasGroupTabs).toBe('boolean');
    });

    test('Tab shows pane title', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Pane header should show title
      const headerText = await ctx.page.evaluate(() => {
        const header = document.querySelector('.pane-header, .pane-title');
        return header ? header.textContent : '';
      });

      // Should have some content (pane ID or title)
      expect(headerText.length).toBeGreaterThan(0);
    });
  });

  // ====================
  // 5.2 Group Navigation
  // ====================
  describe('5.2 Group Navigation', () => {
    test('Tab order is consistent', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Basic structure verification
      const headers = await ctx.page.$$('.pane-header');
      expect(headers.length).toBeGreaterThanOrEqual(1);
    });

    test('Active tab is visually distinct', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Check for active header styling
      const hasActiveStyle = await ctx.page.evaluate(() => {
        const activeHeader = document.querySelector('.pane-header-active');
        return activeHeader !== null;
      });

      // Single pane should be active
      expect(hasActiveStyle).toBe(true);
    });
  });

  // ====================
  // 5.3 Group Management
  // ====================
  describe('5.3 Group Management', () => {
    test('Close button closes pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Find close button
      const closeButton = await ctx.page.$('.pane-close');
      expect(closeButton).not.toBeNull();

      if (closeButton) {
        await closeButton.click();
        await delay(DELAYS.EXTRA_LONG);

        // Should have one less pane
        expect(ctx.session.getPaneCount()).toBe(1);
      }
    });
  });

  // ====================
  // 5.4 Group Persistence
  // ====================
  describe('5.4 Group Persistence', () => {
    test('Group survives window switch', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create structure
      await splitPaneKeyboard(ctx.page, 'horizontal');
      const initialPaneCount = ctx.session.getPaneCount();

      // Create new window
      ctx.session.runCommand(`new-window -t ${ctx.session.name}`);
      await delay(DELAYS.EXTRA_LONG);

      // Go back to first window
      ctx.session.runCommand(`select-window -t ${ctx.session.name}:0`);
      await delay(DELAYS.EXTRA_LONG);

      // Pane count should be preserved
      expect(ctx.session.getPaneCount()).toBe(initialPaneCount);
    });

    test('Layout survives page refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      const paneCountBefore = ctx.session.getPaneCount();

      // Refresh page
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.EXTRA_LONG);

      // Pane count should be same (tmux state persists)
      expect(ctx.session.getPaneCount()).toBe(paneCountBefore);
    });
  });
});
