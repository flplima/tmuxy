/**
 * Layout Tests
 *
 * Tests for cycling through tmux layouts and layout operations.
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
  cycleLayoutKeyboard,
  // Assertions
  compareTmuxAndUIState,
  verifyLayoutChanged,
} = require('./helpers');

const ctx = createTestContext();

describe('Layout Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // Helper to set up multi-pane environment
  async function setupPanes(count = 3) {
    await ctx.navigateToSession();
    await focusPage(ctx.page);

    for (let i = 1; i < count; i++) {
      await splitPaneKeyboard(ctx.page, i % 2 === 0 ? 'vertical' : 'horizontal');
    }
    expect(getTmuxPaneCount(ctx.testSession)).toBe(count);
  }

  describe('Cycle Layout (Ctrl+a Space)', () => {
    test('cycle layout changes pane arrangement', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(3);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before cycle:', beforePanes.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height
      })));

      // Cycle layout
      await cycleLayoutKeyboard(ctx.page);

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      console.log('After cycle:', afterPanes.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height
      })));

      // Layout should have changed
      expect(verifyLayoutChanged(beforePanes, afterPanes)).toBe(true);

      // Pane count should remain the same
      expect(afterPanes.length).toBe(beforePanes.length);
    }, 45000);

    test('cycle through all layouts', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(4);

      const layouts = [];

      // tmux has 5 preset layouts, cycle through them
      for (let i = 0; i < 6; i++) {
        const panes = getTmuxPaneInfo(ctx.testSession);
        const layoutKey = panes.map(p => `${p.x},${p.y},${p.width},${p.height}`).join('|');
        layouts.push(layoutKey);
        console.log(`Layout ${i}:`, layoutKey.substring(0, 50) + '...');

        await cycleLayoutKeyboard(ctx.page);
      }

      // Should have seen different layouts
      const uniqueLayouts = new Set(layouts);
      console.log('Unique layouts:', uniqueLayouts.size);
      expect(uniqueLayouts.size).toBeGreaterThan(1);
    }, 90000);
  });

  describe('Layout with Different Pane Counts', () => {
    test('layout works with 2 panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(2);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      await cycleLayoutKeyboard(ctx.page);
      const afterPanes = getTmuxPaneInfo(ctx.testSession);

      expect(afterPanes.length).toBe(2);
      expect(verifyLayoutChanged(beforePanes, afterPanes)).toBe(true);
    }, 45000);

    test('layout works with 5 panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(5);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      await cycleLayoutKeyboard(ctx.page);
      const afterPanes = getTmuxPaneInfo(ctx.testSession);

      expect(afterPanes.length).toBe(5);
    }, 60000);
  });

  describe('UI Updates with Layout Changes', () => {
    test('UI reflects layout changes', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(3);
      await delay(DELAYS.SYNC);

      // Cycle layout
      await cycleLayoutKeyboard(ctx.page);
      await delay(DELAYS.SYNC);

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      console.log('UI vs Tmux after layout cycle:', comparison);
      expect(comparison.match).toBe(true);
    }, 45000);

    test('multiple cycles maintain UI sync', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(4);

      // Cycle multiple times
      for (let i = 0; i < 3; i++) {
        await cycleLayoutKeyboard(ctx.page);
        await delay(DELAYS.MEDIUM);

        // Check UI sync after each cycle
        const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
        console.log(`After cycle ${i + 1}:`, {
          ui: comparison.uiPaneCount,
          tmux: comparison.tmuxPaneCount
        });
        expect(comparison.match).toBe(true);
      }
    }, 60000);
  });

  describe('Layout Preserves Pane Content', () => {
    test('pane IDs persist through layout changes', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(3);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      const beforeIds = beforePanes.map(p => p.id).sort();

      // Cycle layout multiple times
      for (let i = 0; i < 3; i++) {
        await cycleLayoutKeyboard(ctx.page);
      }

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      const afterIds = afterPanes.map(p => p.id).sort();

      // Same pane IDs should exist
      expect(afterIds).toEqual(beforeIds);
    }, 60000);
  });

  describe('Layout with Special Cases', () => {
    test('layout with single pane does not fail', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      expect(getTmuxPaneCount(ctx.testSession)).toBe(1);

      // Cycling should not fail with single pane
      await cycleLayoutKeyboard(ctx.page);

      expect(getTmuxPaneCount(ctx.testSession)).toBe(1);

      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);

    test('layout after zoom/unzoom', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupPanes(3);

      const { toggleZoomKeyboard, isPaneZoomed } = require('./helpers');

      // Zoom a pane
      await toggleZoomKeyboard(ctx.page);
      expect(isPaneZoomed(ctx.testSession)).toBe(true);

      // Unzoom
      await toggleZoomKeyboard(ctx.page);
      expect(isPaneZoomed(ctx.testSession)).toBe(false);

      // Now cycle layout
      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      await cycleLayoutKeyboard(ctx.page);
      const afterPanes = getTmuxPaneInfo(ctx.testSession);

      expect(afterPanes.length).toBe(beforePanes.length);
      expect(verifyLayoutChanged(beforePanes, afterPanes)).toBe(true);
    }, 60000);
  });
});
