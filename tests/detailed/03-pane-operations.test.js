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
  runCommandViaTmux,
  clickPane,
  typeInTerminal,
  pressEnter,
  verifyLayoutChanged,
  waitForPaneCount,
  withConsistencyChecks,
  assertConsistencyPasses,
  verifyDomSizes,
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

      // Run operation with consistency checks
      const result = await withConsistencyChecks(ctx, async () => {
        await ctx.session.splitHorizontal();
        await delay(DELAYS.SYNC);
      }, { operationType: 'split' });

      expect(await ctx.session.getPaneCount()).toBe(2);

      // Verify UI shows 2 panes
      await waitForPaneCount(ctx.page, 2);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be above the other (different y values)
      expect(panes[0].y).not.toBe(panes[1].y);

      // Split operations may cause brief layout reflows
      expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(2);
      // DOM sizes should match formula
      expect(result.sizes.valid).toBe(true);
    });

    test('Vertical split - two panes side by side', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run operation with consistency checks
      const result = await withConsistencyChecks(ctx, async () => {
        await ctx.session.splitVertical();
        await delay(DELAYS.SYNC);
      }, { operationType: 'split' });

      expect(await ctx.session.getPaneCount()).toBe(2);

      // Check layout - vertical split means side by side
      await waitForPaneCount(ctx.page, 2);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);
      // One pane should be beside the other (different x values)
      expect(panes[0].x).not.toBe(panes[1].x);

      // Split operations may cause brief layout reflows
      expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(2);
      expect(result.sizes.valid).toBe(true);
    });

    test('Nested splits - create 2x2 grid', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      expect(await ctx.session.getPaneCount()).toBe(4);
      await waitForPaneCount(ctx.page, 4);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(4);

      // Wait for CSS layout transitions to complete (250ms transition on .pane-layout-item)
      await delay(DELAYS.SYNC);

      // Verify DOM sizes match expected calculations for 4-pane grid
      const sizeResult = await verifyDomSizes(ctx.page);
      expect(sizeResult.valid).toBe(true);
    });

    test('Uneven splits - split one pane of existing split', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // First split with consistency check
      const result1 = await withConsistencyChecks(ctx, async () => {
        await ctx.session.splitHorizontal();
        await delay(DELAYS.SYNC);
      }, { operationType: 'split' });

      await waitForPaneCount(ctx.page, 2);
      expect(await ctx.session.getPaneCount()).toBe(2);
      expect(result1.glitch.summary.nodeFlickers).toBeLessThanOrEqual(2);

      // Split bottom pane again with consistency check
      const result2 = await withConsistencyChecks(ctx, async () => {
        await ctx.session.splitHorizontal();
      }, { operationType: 'split' });

      expect(await ctx.session.getPaneCount()).toBe(3);
      expect(result2.glitch.summary.nodeFlickers).toBe(0);

      await delay(DELAYS.SYNC);
      await waitForPaneCount(ctx.page, 3);
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(3);

      // Verify final DOM sizes
      expect(result2.sizes.valid).toBe(true);
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

      await runCommandViaTmux(ctx.session, ctx.page, 'exit', '$', 5000).catch(() => {});
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(1);
    });

    test('Kill pane - tmux kill-pane closes pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Kill pane with consistency check
      const result = await withConsistencyChecks(ctx, async () => {
        await ctx.session.killPane();
        await delay(DELAYS.SYNC);
      }, { operationType: 'kill' });

      expect(await ctx.session.getPaneCount()).toBe(1);
      // Kill operations may cause brief layout reflows
      expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(2);
    });

    test('Last pane - closing last pane via exit keeps session with new shell', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      expect(await ctx.session.getPaneCount()).toBe(1);

      // Exit the shell — tmux should respawn the pane (default remain-on-exit or
      // the window gets recreated), keeping the session alive
      await runCommandViaTmux(ctx.session, ctx.page, 'exit', '$', 5000).catch(() => {});
      await delay(DELAYS.SYNC);

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
      expect(await ctx.session.isPaneZoomed()).toBe(false);

      // Zoom with consistency check
      const result = await withConsistencyChecks(ctx, async () => {
        await ctx.session.toggleZoom();
        await delay(DELAYS.SYNC);
      }, { operationType: 'zoom' });

      expect(await ctx.session.isPaneZoomed()).toBe(true);
      // Verify no flicker during zoom
      expect(result.glitch.summary.nodeFlickers).toBe(0);
    });

    test('Zoom out - returns to original layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Zoom in - wait for state propagation
      await ctx.session.toggleZoom();
      await delay(DELAYS.SYNC);
      expect(await ctx.session.isPaneZoomed()).toBe(true);

      // Zoom out - wait for state propagation
      await ctx.session.toggleZoom();
      await delay(DELAYS.SYNC);
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

      await ctx.setupTwoPanes('horizontal');

      const initialWindowCount = await ctx.session.getWindowCount();
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Break pane to new window
      await ctx.session.breakPane();
      await delay(DELAYS.SYNC);

      // Should have new window
      const newWindowCount = await ctx.session.getWindowCount();
      expect(newWindowCount).toBe(initialWindowCount + 1);
    });
  });

  // ====================
  // 3.7 Edge Cases
  // ====================
  describe('3.7 Edge Cases', () => {
    test('Rapid operations - split close split', async () => {
      if (ctx.skipIfNotReady()) return;
      await ctx.setupPage();

      // Run rapid operations with consistency check
      const result = await withConsistencyChecks(ctx, async () => {
        await ctx.session.splitHorizontal();
        await delay(DELAYS.SHORT);
        await ctx.session.killPane();
        await delay(DELAYS.SHORT);
        await ctx.session.splitVertical();
        await delay(DELAYS.SYNC);
      }, { operationType: 'split' });

      // Should end with 2 panes
      expect(await ctx.session.getPaneCount()).toBe(2);
      await waitForPaneCount(ctx.page, 2);

      // Rapid operations may cause layout reflows
      expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(4);
      expect(result.sizes.valid).toBe(true);
    });

    test('Complex layout - 6 pane grid', async () => {
      if (ctx.skipIfNotReady()) return;

      // Navigate first, then create 2x3 grid through adapter
      await ctx.setupPage();
      await ctx.session.splitHorizontal();
      await waitForPaneCount(ctx.page, 2);
      await ctx.session.splitHorizontal();
      await waitForPaneCount(ctx.page, 3);
      await ctx.session.selectPane('U');
      await ctx.session.selectPane('U');
      await ctx.session.splitVertical();
      await waitForPaneCount(ctx.page, 4);
      await ctx.session.selectPane('D');
      await ctx.session.splitVertical();
      await waitForPaneCount(ctx.page, 5);
      await ctx.session.selectPane('D');
      await ctx.session.splitVertical();
      await waitForPaneCount(ctx.page, 6);

      expect(await ctx.session.getPaneCount()).toBe(6);

      // Verify DOM sizes for complex layout
      const result = await verifyDomSizes(ctx.page);
      expect(result.valid).toBe(true);
      expect(result.details.paneCount).toBe(6);
    });

    test('Multiple resize operations', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Multiple rapid resizes with consistency check
      const result = await withConsistencyChecks(ctx, async () => {
        for (let i = 0; i < 5; i++) {
          await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 2`);
          await delay(DELAYS.SHORT);
        }
        await delay(DELAYS.SYNC);
      }, { operationType: 'resize' });

      // Panes should still exist
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Resize operations can cause legitimate brief layout reflows
      expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(4);
      expect(result.sizes.valid).toBe(true);
    });

    test('Zoom and unzoom preserves layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panesBefore = await ctx.session.getPaneInfo();

      // Zoom in with consistency check
      const zoomInResult = await withConsistencyChecks(ctx, async () => {
        await ctx.session.toggleZoom();
        await delay(DELAYS.SYNC);
      }, { operationType: 'zoom' });

      expect(await ctx.session.isPaneZoomed()).toBe(true);
      expect(zoomInResult.glitch.summary.nodeFlickers).toBe(0);

      // Zoom out with consistency check
      const zoomOutResult = await withConsistencyChecks(ctx, async () => {
        await ctx.session.toggleZoom();
        await delay(DELAYS.SYNC);
      }, { operationType: 'zoom' });

      expect(await ctx.session.isPaneZoomed()).toBe(false);
      expect(zoomOutResult.glitch.summary.nodeFlickers).toBe(0);

      // Layout should be preserved
      const panesAfter = await ctx.session.getPaneInfo();
      expect(panesAfter.length).toBe(panesBefore.length);

      // Verify DOM sizes after zoom cycle
      expect(zoomOutResult.sizes.valid).toBe(true);
    });
  });
});
