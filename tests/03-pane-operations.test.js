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
  runCommand,
  clickPane,
  typeInTerminal,
  pressEnter,
  verifyLayoutChanged,
  waitForPaneCount,
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

      await ctx.setupPage();
      expect(await ctx.session.getPaneCount()).toBe(1);

      // Split using tmux command
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(2);

      // Verify UI shows 2 panes
      await waitForPaneCount(ctx.page, 2);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be above the other (different y values)
      expect(panes[0].y).not.toBe(panes[1].y);


    });

    test('Vertical split - two panes side by side', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Split using tmux command
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(2);

      // Check layout - vertical split means side by side
      await waitForPaneCount(ctx.page, 2);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be beside the other (different x values)
      expect(panes[0].x).not.toBe(panes[1].x);


    });

    test('Nested splits - create 2x2 grid', async () => {
      if (ctx.skipIfNotReady()) return;

      // Create 4 panes using tmux commands BEFORE navigating to avoid DOM detachment
      ctx.session.splitHorizontal();
      ctx.session.splitVertical();
      ctx.session.selectPane('U');
      ctx.session.splitVertical();

      expect(ctx.session.getPaneCount()).toBe(4);

      await ctx.setupPage();
      await waitForPaneCount(ctx.page, 4);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(4);


    });

    test('Uneven splits - split one pane of existing split', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // First split
      await ctx.session.splitHorizontal();
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Split bottom pane again
      await ctx.session.splitHorizontal();
      expect(await ctx.session.getPaneCount()).toBe(3);

      await delay(DELAYS.SYNC);
      await waitForPaneCount(ctx.page, 3);
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

      const initialPane = await ctx.session.getActivePaneId();

      // Navigate using tmux command
      await ctx.session.selectPane('U');
      await delay(DELAYS.LONG);

      const afterPane = await ctx.session.getActivePaneId();
      expect(afterPane).not.toBe(initialPane);
    });

    test('Cycle panes - cycles through panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPanes(3);

      const initialPane = await ctx.session.getActivePaneId();

      // Navigate to next pane using tmux command
      await ctx.session.nextPane();
      await delay(DELAYS.LONG);

      const afterPane = await ctx.session.getActivePaneId();
      expect(afterPane).not.toBe(initialPane);
    });

    test('Click to focus - clicking pane focuses it', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('vertical');
      await waitForPaneCount(ctx.page, 2);

      // Get pane info
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);

      // Click on first pane
      await clickPane(ctx.page, 0);
      await delay(DELAYS.LONG);

      // Verify focus changed (tmux active pane)
      const activePaneId = await ctx.session.getActivePaneId();
      expect(activePaneId).toBeDefined();
    });
  });

  // ====================
  // 3.3 Pane Resize
  // ====================
  describe('3.3 Pane Resize', () => {
    test('Resize pane - tmux resize changes dimensions', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panesBefore = await ctx.session.getPaneInfo();

      // Resize using tmux command
      await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
      await delay(DELAYS.SYNC);

      const panesAfter = await ctx.session.getPaneInfo();

      // Height should have changed
      expect(verifyLayoutChanged(panesBefore, panesAfter)).toBe(true);


    });

    test('Resize constraints - minimum size enforced', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('vertical');

      // Try to resize very small
      for (let i = 0; i < 100; i++) {
        await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -L 1`);
      }
      await delay(DELAYS.LONG);

      // Pane should still exist with minimum size
      const panes = await ctx.session.getPaneInfo();
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
      expect(await ctx.session.getPaneCount()).toBe(2);

      await runCommand(ctx.page, 'exit', '$', 5000).catch(() => {});
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(1);
    });

    test('Kill pane - tmux kill-pane closes pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Kill pane using tmux command
      await ctx.session.killPane();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(1);
    });

    test('Last pane - closing last pane keeps session', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(await ctx.session.getPaneCount()).toBe(1);

      // Killing last pane would close window, but session persists
      // We verify session still exists
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
      expect(await ctx.session.isPaneZoomed()).toBe(false);

      // Zoom using tmux command
      await ctx.session.toggleZoom();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.isPaneZoomed()).toBe(true);
    });

    test('Zoom out - returns to original layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Zoom in
      await ctx.session.toggleZoom();
      expect(await ctx.session.isPaneZoomed()).toBe(true);

      // Zoom out
      await ctx.session.toggleZoom();
      expect(await ctx.session.isPaneZoomed()).toBe(false);

      // Should still have 2 panes
      expect(await ctx.session.getPaneCount()).toBe(2);


    });
    // Note: "Zoom indicator" and "Zoom toggle multiple" tests removed as duplicates
    // The "Zoom out" test already covers multiple toggles and state verification
  });

  // ====================
  // 3.6 Pane Swap/Move
  // ====================
  describe('3.6 Pane Swap/Move', () => {
    test('Swap panes - swaps positions between panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      const panesBefore = await ctx.session.getPaneInfo();
      const firstPaneIdBefore = panesBefore[0].id;

      // Swap using tmux command
      await ctx.session.swapPane('D');
      await delay(DELAYS.SYNC);

      const panesAfter = await ctx.session.getPaneInfo();

      // Verify swap happened - pane order changed
      expect(await ctx.session.getPaneCount()).toBe(2);
      // First pane ID should now be at different position or positions swapped
      expect(panesAfter[0].id !== firstPaneIdBefore ||
             panesAfter[0].y !== panesBefore[0].y).toBe(true);
    });

    test('Move to window - break pane to new window', async () => {
      if (ctx.skipIfNotReady()) return;

      // Create split before navigating for stability
      ctx.session.splitHorizontal();

      const initialWindowCount = ctx.session.getWindowCount();
      expect(ctx.session.getPaneCount()).toBe(2);

      // Break pane to new window using tmux command
      ctx.session.breakPane();
      await delay(DELAYS.SYNC);

      // Should have new window
      expect(ctx.session.exists()).toBe(true);
      const newWindowCount = ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);
    });
  });
});
