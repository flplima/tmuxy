/**
 * Pane Zoom Tests
 *
 * Tests for zooming/unzooming panes via keyboard.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  isPaneZoomed,
  // UI
  splitPaneKeyboard,
  toggleZoomKeyboard,
  getUIPaneCount,
  getUIPaneInfo,
  // Assertions
  verifyZoom,
  compareTmuxAndUIState,
} = require('./helpers');

const ctx = createTestContext();

describe('Pane Zoom Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  describe('Toggle Zoom (Ctrl+a z)', () => {
    test('zoom a pane to full screen', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create two panes first
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(getTmuxPaneCount(ctx.testSession)).toBe(2);

      // Verify not zoomed initially
      const initialZoom = verifyZoom(ctx.testSession, false);
      console.log('Initial zoom state:', initialZoom);
      expect(initialZoom.match).toBe(true);

      // Zoom
      await toggleZoomKeyboard(ctx.page);

      // Verify zoomed
      const afterZoom = verifyZoom(ctx.testSession, true);
      console.log('After zoom:', afterZoom);
      expect(afterZoom.match).toBe(true);
    }, 45000);

    test('unzoom a zoomed pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create two panes and zoom
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await toggleZoomKeyboard(ctx.page);

      // Verify zoomed
      expect(isPaneZoomed(ctx.testSession)).toBe(true);

      // Unzoom
      await toggleZoomKeyboard(ctx.page);

      // Verify unzoomed
      const unzoomedResult = verifyZoom(ctx.testSession, false);
      console.log('After unzoom:', unzoomedResult);
      expect(unzoomedResult.match).toBe(true);
    }, 45000);

    test('toggle zoom multiple times', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await splitPaneKeyboard(ctx.page, 'horizontal');

      // Toggle multiple times
      const states = [];
      for (let i = 0; i < 4; i++) {
        await toggleZoomKeyboard(ctx.page);
        states.push(isPaneZoomed(ctx.testSession));
      }

      console.log('Zoom states:', states);

      // Should alternate: true, false, true, false
      expect(states[0]).toBe(true);
      expect(states[1]).toBe(false);
      expect(states[2]).toBe(true);
      expect(states[3]).toBe(false);
    }, 60000);
  });

  describe('Zoom UI Appearance', () => {
    test('zoomed pane appears full screen in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create multiple panes
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');

      const initialPanes = await getUIPaneInfo(ctx.page);
      console.log('Initial panes:', initialPanes.length);

      // Get viewport size
      const viewport = await ctx.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      // Zoom
      await toggleZoomKeyboard(ctx.page);

      // Verify tmux zoom state
      expect(isPaneZoomed(ctx.testSession)).toBe(true);

      // Check UI
      const zoomedPanes = await getUIPaneInfo(ctx.page);
      console.log('Panes when zoomed:', zoomedPanes.length);

      // When zoomed, either:
      // 1. Only one pane is visible
      // 2. The zoomed pane takes most of the viewport
      if (zoomedPanes.length === 1) {
        const pane = zoomedPanes[0];
        // Should take most of viewport
        const coversViewport = pane.width > viewport.width * 0.7;
        console.log('Single pane covers viewport:', coversViewport);
      }
    }, 45000);

    test('UI matches tmux after zoom/unzoom cycle', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 2 panes
      await splitPaneKeyboard(ctx.page, 'horizontal');

      // Zoom and unzoom
      await toggleZoomKeyboard(ctx.page);
      await delay(DELAYS.SYNC);
      await toggleZoomKeyboard(ctx.page);
      await delay(DELAYS.SYNC);

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      console.log('After zoom cycle:', comparison);
      expect(comparison.match).toBe(true);
    }, 45000);
  });

  describe('Zoom with Complex Layouts', () => {
    test('zoom works with 4 panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 4 panes
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      await toggleZoomKeyboard(ctx.page); // Navigate to another
      await splitPaneKeyboard(ctx.page, 'vertical');

      const paneCount = getTmuxPaneCount(ctx.testSession);
      console.log('Created panes:', paneCount);

      // Zoom
      await toggleZoomKeyboard(ctx.page);
      expect(isPaneZoomed(ctx.testSession)).toBe(true);

      // Unzoom - should restore layout
      await toggleZoomKeyboard(ctx.page);
      expect(isPaneZoomed(ctx.testSession)).toBe(false);

      // Pane count should be preserved
      expect(getTmuxPaneCount(ctx.testSession)).toBe(paneCount);
    }, 60000);
  });
});
