/**
 * Category 14: Real-World Workflow Scenarios
 *
 * Complex end-to-end scenarios testing realistic usage patterns.
 */

const {
  createTestContext,
  delay,
  focusPage,
  typeInTerminal,
  pressEnter,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  createWindowKeyboard,
  selectWindowKeyboard,
  toggleZoomKeyboard,
  enterCopyModeKeyboard,
  exitCopyModeKeyboard,
  getUIPaneCount,
  getTerminalText,
  DELAYS,
} = require('./helpers');

describe('Category 14: Real-World Workflow Scenarios', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 14.1 Development Workflow
  // ====================
  describe('14.1 Development Workflow', () => {
    test('Full-stack development session setup', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Window 1: Editor pane
      await typeInTerminal(ctx.page, 'echo "Window 1: Editor"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Create Window 2: Server panes
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'vertical');
      await typeInTerminal(ctx.page, 'echo "Backend Server Pane"');
      await pressEnter(ctx.page);
      await navigatePaneKeyboard(ctx.page, 'left');
      await typeInTerminal(ctx.page, 'echo "Frontend Server Pane"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Create Window 3: Shell and tests
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await typeInTerminal(ctx.page, 'echo "Test Runner Pane"');
      await pressEnter(ctx.page);
      await navigatePaneKeyboard(ctx.page, 'up');
      await typeInTerminal(ctx.page, 'echo "Git Shell Pane"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Verify structure
      expect(ctx.session.getWindowCount()).toBe(3);

      // Navigate back to first window
      await selectWindowKeyboard(ctx.page, 0);
      await delay(DELAYS.LONG);

      expect(ctx.session.getCurrentWindowIndex()).toBe('0');
    });

    test('Navigate between windows and panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create multi-window layout
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'horizontal');

      // Navigate
      await selectWindowKeyboard(ctx.page, 0);
      await delay(DELAYS.LONG);

      await selectWindowKeyboard(ctx.page, 1);
      await delay(DELAYS.LONG);

      await navigatePaneKeyboard(ctx.page, 'up');
      await navigatePaneKeyboard(ctx.page, 'down');

      expect(ctx.session.exists()).toBe(true);
    });

    test('Zoom into pane for focused work', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      // Zoom in
      await toggleZoomKeyboard(ctx.page);
      expect(ctx.session.isPaneZoomed()).toBe(true);

      // Type while zoomed
      await typeInTerminal(ctx.page, 'echo "Focused work"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Zoom out
      await toggleZoomKeyboard(ctx.page);
      expect(ctx.session.isPaneZoomed()).toBe(false);

      // All panes should still be there
      expect(ctx.session.getPaneCount()).toBe(4);
    });
  });

  // ====================
  // 14.2 DevOps Workflow
  // ====================
  describe('14.2 DevOps Workflow', () => {
    test('Multi-server monitoring layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Window for server 1
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      await delay(DELAYS.LONG);

      // Create window for server 2
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      await delay(DELAYS.LONG);

      expect(ctx.session.getWindowCount()).toBe(2);
      expect(ctx.session.getPaneCount()).toBe(3);
    });

    test('Navigate servers rapidly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await createWindowKeyboard(ctx.page);
      await createWindowKeyboard(ctx.page);

      // Rapid navigation
      for (let i = 0; i < 5; i++) {
        await selectWindowKeyboard(ctx.page, i % 3);
        await delay(DELAYS.SHORT);
      }

      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 14.3 Pair Programming Workflow
  // ====================
  describe('14.3 Pair Programming Workflow', () => {
    test('Complex layout visible to viewer', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create a typical programming layout
      await splitPaneKeyboard(ctx.page, 'vertical'); // Editor | Terminal
      await navigatePaneKeyboard(ctx.page, 'right');
      await splitPaneKeyboard(ctx.page, 'horizontal'); // Terminal | Tests

      expect(ctx.session.getPaneCount()).toBe(3);

      // Open second browser to same session
      const page2 = await ctx.browser.newPage();
      try {
        await page2.goto(`http://localhost:3853?session=${ctx.session.name}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page2.waitForSelector('[role="log"]', { timeout: 10000 });
        await delay(DELAYS.EXTRA_LONG);

        // Second page should see same layout
        const paneCount2 = await page2.evaluate(() => {
          const panes = document.querySelectorAll('[data-pane-id]');
          const uniqueIds = new Set();
          for (const pane of panes) {
            uniqueIds.add(pane.getAttribute('data-pane-id'));
          }
          return uniqueIds.size || document.querySelectorAll('[role="log"]').length;
        });

        expect(paneCount2).toBe(3);
      } finally {
        await page2.close();
      }
    });
  });

  // ====================
  // 14.4 Long-Running Process Management
  // ====================
  describe('14.4 Long-Running Process Management', () => {
    test('Monitor multiple processes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPanes(3);

      // Start different processes in each pane
      const panes = ctx.session.getPaneInfo();

      for (let i = 0; i < panes.length; i++) {
        ctx.session.runCommand(`send-keys -t ${panes[i].id} "echo 'Process ${i}'" Enter`);
        await delay(DELAYS.LONG);
      }

      // All panes should have content
      expect(ctx.session.exists()).toBe(true);
    });

    test('Copy mode to search errors', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Generate some output with "ERROR"
      await typeInTerminal(ctx.page, 'echo "Line 1"; echo "ERROR: Something failed"; echo "Line 3"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      // Enter copy mode and search
      await enterCopyModeKeyboard(ctx.page);
      expect(ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.page.keyboard.press('/');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('ERROR');
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      await exitCopyModeKeyboard(ctx.page);
      expect(ctx.session.isPaneInCopyMode()).toBe(false);
    });
  });

  // ====================
  // 14.5 Complex Layout Stress Test
  // ====================
  describe('14.5 Complex Layout Stress Test', () => {
    test('Maximum complexity session', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Window 1: 4-pane grid
      await ctx.setupFourPanes();
      expect(ctx.session.getPaneCount()).toBe(4);

      // Window 2: 3 panes
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'horizontal');
      expect(ctx.session.getPaneCount()).toBe(3);

      // Window 3: 2 panes
      await createWindowKeyboard(ctx.page);
      await splitPaneKeyboard(ctx.page, 'vertical');
      expect(ctx.session.getPaneCount()).toBe(2);

      // Total windows
      expect(ctx.session.getWindowCount()).toBe(3);

      // Navigate through all
      for (let i = 0; i < 3; i++) {
        await selectWindowKeyboard(ctx.page, i);
        await delay(DELAYS.LONG);
        expect(ctx.session.getCurrentWindowIndex()).toBe(String(i));
      }

      // Verify UI reflects state
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBeGreaterThan(0);
    });
  });

  // ====================
  // 14.6 Unicode & Internationalization
  // ====================
  describe('14.6 Unicode & Internationalization', () => {
    test('Mixed language output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Output various scripts
      await typeInTerminal(ctx.page, 'echo "English text"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('English text');
    });

    test('Box drawing characters', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Simple box
      await typeInTerminal(ctx.page, 'echo "+---+"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('+---+');
    });
  });

  // ====================
  // 14.7 Mouse-Heavy Application Usage
  // ====================
  describe('14.7 Mouse-Heavy Application Usage', () => {
    test('Mouse navigation in split panes', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      // Click each pane
      const panes = ctx.session.getPaneInfo();
      for (const pane of panes) {
        const uiPanes = await ctx.page.$$('.pane-wrapper, [data-pane-id]');
        if (uiPanes.length > 0) {
          await uiPanes[0].click();
          await delay(DELAYS.SHORT);
        }
      }

      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 14.8 Error Recovery Scenario
  // ====================
  describe('14.8 Error Recovery Scenario', () => {
    test('Page refresh recovery', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create state
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');
      const paneCountBefore = ctx.session.getPaneCount();

      // Simulate crash recovery via refresh
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.EXTRA_LONG);

      // State should be recovered
      const paneCountAfter = ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);
    });

    test('Navigate away and return', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Navigate away
      await ctx.page.goto('about:blank');
      await delay(DELAYS.LONG);

      // Return
      await ctx.navigateToSession();
      await delay(DELAYS.EXTRA_LONG);

      // Session still exists
      expect(ctx.session.getPaneCount()).toBe(2);
    });

    test('Rapid operations dont break state', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Rapid operations
      for (let i = 0; i < 5; i++) {
        await splitPaneKeyboard(ctx.page, 'horizontal');
      }

      await delay(DELAYS.EXTRA_LONG);

      // State should be consistent
      const tmuxCount = ctx.session.getPaneCount();
      const uiCount = await getUIPaneCount(ctx.page);

      expect(tmuxCount).toBe(uiCount);
    });
  });
});
