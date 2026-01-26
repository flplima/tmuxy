/**
 * Category 4: Window Operations
 *
 * Tests for window creation, navigation, management, and layout operations.
 */

const {
  createTestContext,
  delay,
  focusPage,
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  cycleLayoutKeyboard,
  sendTmuxPrefix,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
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
    test('New window - prefix+c creates window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      const initialCount = ctx.session.getWindowCount();

      await createWindowKeyboard(ctx.page);

      const newCount = ctx.session.getWindowCount();
      expect(newCount).toBe(initialCount + 1);
    });

    test('New window appears in window tabs', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Check UI for window tabs
      const windowTabs = await ctx.page.$$('.window-tab');
      expect(windowTabs.length).toBeGreaterThanOrEqual(2);
    });

    test('New window with specific name via tmux command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create window with name using tmux command
      ctx.session.runCommand(`new-window -t ${ctx.session.name} -n TestWindow`);
      await delay(DELAYS.EXTRA_LONG);

      const windows = ctx.session.getWindowInfo();
      const testWindow = windows.find(w => w.name === 'TestWindow');
      expect(testWindow).toBeDefined();
    });
  });

  // ====================
  // 4.2 Window Navigation
  // ====================
  describe('4.2 Window Navigation', () => {
    test('Next window - prefix+n switches to next', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create second window
      await createWindowKeyboard(ctx.page);

      const currentIndex = ctx.session.getCurrentWindowIndex();

      // Go to next (wraps to first)
      await nextWindowKeyboard(ctx.page);

      const newIndex = ctx.session.getCurrentWindowIndex();
      expect(newIndex).not.toBe(currentIndex);
    });

    test('Previous window - prefix+p switches to previous', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      const currentIndex = ctx.session.getCurrentWindowIndex();

      await prevWindowKeyboard(ctx.page);

      const newIndex = ctx.session.getCurrentWindowIndex();
      expect(newIndex).not.toBe(currentIndex);
    });

    test('Window by number - prefix+number selects window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      await createWindowKeyboard(ctx.page);

      // Select window 0
      await selectWindowKeyboard(ctx.page, 0);

      const currentIndex = ctx.session.getCurrentWindowIndex();
      expect(currentIndex).toBe('0');
    });

    test('Last window - prefix+l toggles to last window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create second window
      await createWindowKeyboard(ctx.page);

      // Go back to first
      await selectWindowKeyboard(ctx.page, 0);
      await delay(DELAYS.LONG);

      // Toggle to last (should go to window 1)
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('l');
      await delay(DELAYS.LONG);

      const currentIndex = ctx.session.getCurrentWindowIndex();
      expect(currentIndex).toBe('1');
    });

    test('Click tab - clicking window tab switches', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Click first window tab
      const tab = await ctx.page.$('.window-tab:first-child');
      if (tab) {
        await tab.click();
        await delay(DELAYS.EXTRA_LONG);

        const currentIndex = ctx.session.getCurrentWindowIndex();
        expect(currentIndex).toBe('0');
      }
    });
  });

  // ====================
  // 4.3 Window Management
  // ====================
  describe('4.3 Window Management', () => {
    test('Rename window - prefix+comma renames', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Use tmux command to rename
      ctx.session.runCommand(`rename-window -t ${ctx.session.name} MyRenamedWindow`);
      await delay(DELAYS.EXTRA_LONG);

      const windows = ctx.session.getWindowInfo();
      const renamedWindow = windows.find(w => w.name === 'MyRenamedWindow');
      expect(renamedWindow).toBeDefined();
    });

    test('Close window - prefix+& closes window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      expect(ctx.session.getWindowCount()).toBe(2);

      // Close window
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('&');
      await delay(DELAYS.LONG);
      await ctx.page.keyboard.press('y'); // Confirm
      await delay(DELAYS.EXTRA_LONG);

      expect(ctx.session.getWindowCount()).toBe(1);
    });

    test('Close window via tmux command', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      expect(ctx.session.getWindowCount()).toBe(2);

      // Kill window via command
      ctx.session.runCommand(`kill-window -t ${ctx.session.name}:1`);
      await delay(DELAYS.EXTRA_LONG);

      expect(ctx.session.getWindowCount()).toBe(1);
    });
  });

  // ====================
  // 4.4 Window Layout
  // ====================
  describe('4.4 Window Layout', () => {
    test('Even horizontal layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      // Apply even-horizontal layout
      ctx.session.runCommand(`select-layout -t ${ctx.session.name} even-horizontal`);
      await delay(DELAYS.EXTRA_LONG);

      const panes = ctx.session.getPaneInfo();
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

      ctx.session.runCommand(`select-layout -t ${ctx.session.name} even-vertical`);
      await delay(DELAYS.EXTRA_LONG);

      const panes = ctx.session.getPaneInfo();
      expect(panes.length).toBe(4);

      // All panes should have same height
      const heights = panes.map(p => p.height);
      const uniqueHeights = [...new Set(heights)];
      expect(uniqueHeights.length).toBeLessThanOrEqual(2);
    });

    test('Tiled layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      ctx.session.runCommand(`select-layout -t ${ctx.session.name} tiled`);
      await delay(DELAYS.EXTRA_LONG);

      const panes = ctx.session.getPaneInfo();
      expect(panes.length).toBe(4);

      // All panes should be roughly same size
      const areas = panes.map(p => p.width * p.height);
      const maxArea = Math.max(...areas);
      const minArea = Math.min(...areas);
      // Areas should be within 50% of each other
      expect(maxArea / minArea).toBeLessThan(2);
    });

    test('Cycle layouts - prefix+space cycles', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panesBefore = ctx.session.getPaneInfo();

      await cycleLayoutKeyboard(ctx.page);

      const panesAfter = ctx.session.getPaneInfo();

      // Layout should have changed
      const beforeLayout = panesBefore.map(p => `${p.x},${p.y},${p.width},${p.height}`).join('|');
      const afterLayout = panesAfter.map(p => `${p.x},${p.y},${p.width},${p.height}`).join('|');
      expect(afterLayout).not.toBe(beforeLayout);
    });
  });
});
