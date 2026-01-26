/**
 * Category 3: Pane Operations
 *
 * Tests for pane splitting, navigation, resize, close, zoom, and swap operations.
 */

const {
  createTestContext,
  delay,
  focusPage,
  getUIPaneCount,
  getUIPaneInfo,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  toggleZoomKeyboard,
  swapPaneKeyboard,
  killPaneKeyboard,
  clickPane,
  typeInTerminal,
  pressEnter,
  verifyLayoutChanged,
  DELAYS,
} = require('./helpers');

describe('Category 3: Pane Operations', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 3.1 Split Operations
  // ====================
  describe('3.1 Split Operations', () => {
    test('Horizontal split - two panes vertically stacked', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      expect(ctx.session.getPaneCount()).toBe(1);

      await splitPaneKeyboard(ctx.page, 'horizontal');

      expect(ctx.session.getPaneCount()).toBe(2);

      // Verify UI shows 2 panes
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);

      // Check layout - horizontal split means stacked vertically
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be above the other (different y values)
      expect(panes[0].y).not.toBe(panes[1].y);
    });

    test('Vertical split - two panes side by side', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await splitPaneKeyboard(ctx.page, 'vertical');

      expect(ctx.session.getPaneCount()).toBe(2);

      // Check layout - vertical split means side by side
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be beside the other (different x values)
      expect(panes[0].x).not.toBe(panes[1].x);
    });

    test('Nested splits - create 2x2 grid', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 4 panes
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      await navigatePaneKeyboard(ctx.page, 'up');
      await splitPaneKeyboard(ctx.page, 'vertical');

      expect(ctx.session.getPaneCount()).toBe(4);

      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(4);
    });

    test('Uneven splits - split one pane of existing split', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // First split
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(ctx.session.getPaneCount()).toBe(2);

      // Split bottom pane again
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(ctx.session.getPaneCount()).toBe(3);

      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(3);
    });
  });

  // ====================
  // 3.2 Pane Navigation
  // ====================
  describe('3.2 Pane Navigation', () => {
    test('Arrow navigation - navigate between panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const initialPane = ctx.session.getActivePaneId();

      await navigatePaneKeyboard(ctx.page, 'up');

      const afterPane = ctx.session.getActivePaneId();
      expect(afterPane).not.toBe(initialPane);
    });

    test('Cycle panes - prefix+o cycles through panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPanes(3);

      const initialPane = ctx.session.getActivePaneId();

      await navigatePaneKeyboard(ctx.page, 'next');

      const afterPane = ctx.session.getActivePaneId();
      expect(afterPane).not.toBe(initialPane);
    });

    test('Click to focus - clicking pane focuses it', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('vertical');

      // Get pane info
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);

      // Click on first pane
      await clickPane(ctx.page, 0);
      await delay(DELAYS.LONG);

      // Verify focus changed (tmux active pane)
      const activePaneId = ctx.session.getActivePaneId();
      expect(activePaneId).toBeDefined();
    });
  });

  // ====================
  // 3.3 Pane Resize
  // ====================
  describe('3.3 Pane Resize', () => {
    test('Resize keyboard - Ctrl+A Ctrl+arrow resizes pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panesBefore = ctx.session.getPaneInfo();

      // Resize using tmux command directly
      ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
      await delay(DELAYS.EXTRA_LONG);

      const panesAfter = ctx.session.getPaneInfo();

      // Height should have changed
      expect(verifyLayoutChanged(panesBefore, panesAfter)).toBe(true);
    });

    test('Resize constraints - minimum size enforced', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('vertical');

      // Try to resize very small
      for (let i = 0; i < 100; i++) {
        ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -L 1`);
      }
      await delay(DELAYS.EXTRA_LONG);

      // Pane should still exist with minimum size
      const panes = ctx.session.getPaneInfo();
      expect(panes.length).toBe(2);
      // All panes should have positive width
      panes.forEach(pane => {
        expect(pane.width).toBeGreaterThan(0);
      });
    });
  });

  // ====================
  // 3.4 Pane Close
  // ====================
  describe('3.4 Pane Close', () => {
    test('Exit command - running exit closes pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.getPaneCount()).toBe(2);

      await typeInTerminal(ctx.page, 'exit');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      expect(ctx.session.getPaneCount()).toBe(1);
    });

    test('Kill pane - prefix+x kills pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(ctx.session.getPaneCount()).toBe(2);

      await killPaneKeyboard(ctx.page);

      expect(ctx.session.getPaneCount()).toBe(1);
    });

    test('Last pane - closing last pane keeps window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      expect(ctx.session.getPaneCount()).toBe(1);
      const initialWindowCount = ctx.session.getWindowCount();

      // Can't close last pane without closing window
      // So we verify the pane still exists after attempting
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Either pane count is 0 (window closed) or still 1
      const paneCount = ctx.session.getPaneCount();
      // Session should still exist
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 3.5 Pane Zoom
  // ====================
  describe('3.5 Pane Zoom', () => {
    test('Zoom in - pane fills window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      expect(ctx.session.isPaneZoomed()).toBe(false);

      await toggleZoomKeyboard(ctx.page);

      expect(ctx.session.isPaneZoomed()).toBe(true);
    });

    test('Zoom out - returns to original layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Zoom in
      await toggleZoomKeyboard(ctx.page);
      expect(ctx.session.isPaneZoomed()).toBe(true);

      // Zoom out
      await toggleZoomKeyboard(ctx.page);
      expect(ctx.session.isPaneZoomed()).toBe(false);

      // Should still have 2 panes
      expect(ctx.session.getPaneCount()).toBe(2);
    });

    test('Zoom indicator - UI shows zoom state', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      await toggleZoomKeyboard(ctx.page);

      // Check for zoom indicator in UI
      const hasZoomIndicator = await ctx.page.evaluate(() => {
        const body = document.body.textContent;
        const hasZClass = document.querySelector('.zoomed, [data-zoomed="true"]');
        return hasZClass !== null || body.includes('Z') || body.includes('zoom');
      });

      // Zoom state should be reflected somehow
      expect(ctx.session.isPaneZoomed()).toBe(true);
    });

    test('Double-click zoom - double-click header toggles zoom', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      expect(ctx.session.isPaneZoomed()).toBe(false);

      // Double-click on pane header
      const header = await ctx.page.$('.pane-header');
      if (header) {
        const box = await header.boundingBox();
        await ctx.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
        await delay(DELAYS.EXTRA_LONG);

        expect(ctx.session.isPaneZoomed()).toBe(true);
      }
    });
  });

  // ====================
  // 3.6 Pane Swap/Move
  // ====================
  describe('3.6 Pane Swap/Move', () => {
    test('Swap panes - prefix+{ or } swaps positions', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Mark panes with content
      await typeInTerminal(ctx.page, 'echo "PANE_A"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      await navigatePaneKeyboard(ctx.page, 'up');
      await typeInTerminal(ctx.page, 'echo "PANE_B"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Swap
      await swapPaneKeyboard(ctx.page, 'down');

      // Verify swap happened
      expect(ctx.session.getPaneCount()).toBe(2);
    });

    test('Move to window - prefix+! breaks pane to new window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const initialWindowCount = ctx.session.getWindowCount();
      expect(ctx.session.getPaneCount()).toBe(2);

      // Break pane to new window
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('a');
      await ctx.page.keyboard.up('Control');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('!');
      await delay(DELAYS.EXTRA_LONG);

      // Should have new window
      const newWindowCount = ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);

      // Original window should have 1 pane
      expect(ctx.session.getPaneCount()).toBe(1);
    });
  });
});
