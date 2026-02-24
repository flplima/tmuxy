/**
 * Category 4: Window Operations
 *
 * Tests for window creation, navigation, management, and layout operations.
 */

const {
  createTestContext,
  delay,
  focusPage,
  waitForPaneCount,
  waitForWindowCount,
  DELAYS,
} = require('./helpers');

describe('Category 4: Window Operations', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 4.1 Window Creation
  // ====================
  describe('4.1 Window Creation', () => {
    test('New window - tmux command creates window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      const initialCount = await ctx.session.getWindowCount();

      // Create window using tmux command
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, initialCount + 1);

      const newCount = await ctx.session.getWindowCount();
      expect(newCount).toBe(initialCount + 1);
    });

    test('New window appears in window tabs', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      // Verify tmux has 2 windows
      expect(await ctx.session.getWindowCount()).toBe(2);

      // Check UI reflects multiple windows
      const windowInfo = await ctx.session.getWindowInfo();
      expect(windowInfo.length).toBe(2);
    });

    test('New window with specific name', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create window with name using newWindow helper
      // (new-window crashes tmux 3.5a control mode, so we use split+break workaround)
      await ctx.session.newWindow('TestWindow');
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      const windows = await ctx.session.getWindowInfo();
      const testWindow = windows.find(w => w.name === 'TestWindow');
      expect(testWindow).toBeDefined();
    });
  });

  // ====================
  // 4.2 Window Navigation
  // ====================
  describe('4.2 Window Navigation', () => {
    test('Next window - switches to next window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create second window
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      const currentIndex = await ctx.session.getCurrentWindowIndex();

      // Go to next (wraps to first)
      await ctx.session.nextWindow();
      await delay(DELAYS.LONG);

      const newIndex = await ctx.session.getCurrentWindowIndex();
      expect(newIndex).not.toBe(currentIndex);


    });

    test('Previous window - switches to previous', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);
      const currentIndex = await ctx.session.getCurrentWindowIndex();

      await ctx.session.previousWindow();
      await delay(DELAYS.LONG);

      const newIndex = await ctx.session.getCurrentWindowIndex();
      expect(newIndex).not.toBe(currentIndex);


    });

    test('Window by number - selects specific window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 3);

      // Select window 1 (base index is 1 in config)
      await ctx.session.selectWindow(1);
      await delay(DELAYS.LONG);

      const currentIndex = await ctx.session.getCurrentWindowIndex();
      expect(currentIndex).toBe('1');


    });

    test('Last window - toggles to last visited window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Initial window is at index 1 (base-index is 1 in config)
      // Create second window (now on window 2)
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      // Go back to first (window 1)
      await ctx.session.selectWindow(1);
      await delay(DELAYS.LONG);

      // Toggle to last window visited (should go to window 2)
      await ctx.session.lastWindow();
      await delay(DELAYS.LONG);

      const currentIndex = await ctx.session.getCurrentWindowIndex();
      expect(currentIndex).toBe('2');


    });

    test('Click tab - clicking window tab switches', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Get the initial window index
      const initialIndex = await ctx.session.getCurrentWindowIndex();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      // Verify we're now on a different window (the new one)
      const afterNewIndex = await ctx.session.getCurrentWindowIndex();
      expect(afterNewIndex).not.toBe(initialIndex);

      // Get tabs and find the one that's NOT active (exclude "+" button)
      const activeTab = await ctx.page.$('.tmuxy-tab-active');
      const allTabs = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      expect(allTabs.length).toBe(2);

      // Find inactive tab by checking which one is not the active tab
      let inactiveTab = null;
      for (const tab of allTabs) {
        const isActive = await tmuxy-tab.evaluate(el => el.classList.contains('tab-active'));
        if (!isActive) {
          inactiveTab = tab;
          break;
        }
      }
      expect(inactiveTab).not.toBeNull();

      // Click the button inside the inactive tab
      const tabButton = await inactiveTab.$('.tmuxy-tab-button');
      expect(tabButton).not.toBeNull();
      await tabButton.click();
      await delay(DELAYS.SYNC);

      // After clicking, the current window should be different
      const finalIndex = await ctx.session.getCurrentWindowIndex();
      expect(finalIndex).not.toBe(afterNewIndex);
    });
  });

  // ====================
  // 4.3 Window Management
  // ====================
  describe('4.3 Window Management', () => {
    test('Rename window - changes window name', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Use helper method to rename
      await ctx.session.renameWindow('MyRenamedWindow');
      await delay(DELAYS.SYNC);

      const windows = await ctx.session.getWindowInfo();
      const renamedWindow = windows.find(w => w.name === 'MyRenamedWindow');
      expect(renamedWindow).toBeDefined();


    });

    test('Close window - kill-window removes window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);
      expect(await ctx.session.getWindowCount()).toBe(2);

      // Get actual window info to find a non-active window to kill
      const windows = await ctx.session.getWindowInfo();
      const inactiveWindow = windows.find(w => !w.active);
      expect(inactiveWindow).toBeDefined();

      await ctx.session.killWindow(inactiveWindow.index);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);

      expect(await ctx.session.getWindowCount()).toBe(1);
    });

    test('Close multiple windows - handles correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SHORT);
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 3);
      expect(await ctx.session.getWindowCount()).toBe(3);

      // Kill windows (leaving only the last one)
      // After newWindow() x2 from window 1, we're on window 3.
      // Get current windows to find the right indices to kill.
      const windows = await ctx.session.getWindowInfo();
      const currentIdx = await ctx.session.getCurrentWindowIndex();
      // Kill all windows except the current one
      for (const w of windows) {
        if (String(w.index) !== String(currentIdx)) {
          await ctx.session.killWindow(w.index);
          await delay(DELAYS.SHORT);
        }
      }
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);

      expect(await ctx.session.getWindowCount()).toBe(1);
    });
  });

  // ====================
  // 4.4 Window Layout
  // ====================
  describe('4.4 Window Layout', () => {
    test('Even horizontal layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      // Apply even-horizontal layout using helper
      await ctx.session.selectLayout('even-horizontal');
      await delay(DELAYS.SYNC);

      const panes = await ctx.session.getPaneInfo();
      expect(panes.length).toBe(4);

      // All panes should have same width
      const widths = panes.map(p => p.width);
      const uniqueWidths = [...new Set(widths)];
      // Should be 1-2 unique widths (rounding)
      expect(uniqueWidths.length).toBeLessThanOrEqual(2);


    });

    test('Even vertical layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      await ctx.session.selectLayout('even-vertical');
      await delay(DELAYS.SYNC);

      const panes = await ctx.session.getPaneInfo();
      expect(panes.length).toBe(4);

      // All panes should have same height
      const heights = panes.map(p => p.height);
      const uniqueHeights = [...new Set(heights)];
      expect(uniqueHeights.length).toBeLessThanOrEqual(2);


    });

    test('Tiled layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      await ctx.session.selectLayout('tiled');
      await delay(DELAYS.SYNC);

      const panes = await ctx.session.getPaneInfo();
      expect(panes.length).toBe(4);

      // All panes should be roughly same size
      const areas = panes.map(p => p.width * p.height);
      const maxArea = Math.max(...areas);
      const minArea = Math.min(...areas);
      // Areas should be within 50% of each other
      expect(maxArea / minArea).toBeLessThan(2);

      // Wait for UI to sync with the layout change
      await waitForPaneCount(ctx.page, 4);

    });

    test('Cycle layouts - next-layout changes layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panesBefore = await ctx.session.getPaneInfo();

      // Cycle layout using helper
      await ctx.session.nextLayout();
      await delay(DELAYS.SYNC);

      const panesAfter = await ctx.session.getPaneInfo();

      // Layout should have changed
      const beforeLayout = panesBefore.map(p => `${p.x},${p.y},${p.width},${p.height}`).join('|');
      const afterLayout = panesAfter.map(p => `${p.x},${p.y},${p.width},${p.height}`).join('|');
      expect(afterLayout).not.toBe(beforeLayout);


    });
  });
});
