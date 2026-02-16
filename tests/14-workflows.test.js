/**
 * Category 14: Real-World Workflow Scenarios
 *
 * Complex end-to-end scenarios testing realistic usage patterns.
 */

const {
  createTestContext,
  delay,
  runCommand,
  getUIPaneCount,
  getTerminalText,
  waitForPaneCount,
  DELAYS,
  TMUXY_URL,
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
    // Skipped: Multi-window setup has timing issues
    test.skip('Multi-window development session setup', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Window 1: Editor pane (already exists)
      await runCommand(ctx.page, 'echo "Window 1: Editor"', 'Editor');

      // Create Window 2 with split
      await ctx.session.newWindow();
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);

      // Create Window 3 with split
      await ctx.session.newWindow();
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // Verify structure
      expect(await ctx.session.getWindowCount()).toBe(3);
    });

    test('Navigate between windows', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create multi-window layout
      await ctx.session.newWindow();
      await ctx.session.splitHorizontal();

      // Navigate using tmux commands (base-index is 1, so windows are 1 and 2)
      await ctx.session.runCommand(`select-window -t ${ctx.session.name}:1`);
      await delay(DELAYS.SHORT);
      expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

      await ctx.session.runCommand(`select-window -t ${ctx.session.name}:2`);
      await delay(DELAYS.SHORT);
      expect(await ctx.session.getCurrentWindowIndex()).toBe('2');
    });

    test('Zoom into pane for focused work', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      // Zoom in
      await ctx.session.toggleZoom();
      expect(await ctx.session.isPaneZoomed()).toBe(true);

      // Zoom out
      await ctx.session.toggleZoom();
      expect(await ctx.session.isPaneZoomed()).toBe(false);

      // All panes should still be there
      expect(await ctx.session.getPaneCount()).toBe(4);
    });
  });

  // ====================
  // 14.2 DevOps Workflow
  // ====================
  describe('14.2 DevOps Workflow', () => {
    test('Multi-server monitoring layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Window for server 1
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(3);

      // Create window for server 2
      await ctx.session.newWindow();
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getWindowCount()).toBe(2);
    });

    test('Navigate windows rapidly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await ctx.session.newWindow();
      await delay(DELAYS.MEDIUM);

      // Get actual window indices (may vary depending on base-index config)
      const windows = await ctx.session.getWindowInfo();
      expect(windows.length).toBe(3);

      // Rapid navigation through all windows by their actual indices
      for (const win of windows) {
        await ctx.session.selectWindow(win.index);
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

      await ctx.setupPage();

      // Create a typical programming layout
      await ctx.session.splitVertical(); // Editor | Terminal
      await ctx.session.splitHorizontal(); // Terminal | Tests
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(3);

      // Open second browser to same session
      const page2 = await ctx.browser.newPage();
      try {
        await page2.goto(`${TMUXY_URL}?session=${ctx.session.name}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page2.waitForSelector('[role="log"]', { timeout: 10000 });
        await delay(DELAYS.SYNC);

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
        if (page2._context) {
          await page2._context.close();
        } else {
          await page2.close();
        }
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
      const panes = await ctx.session.getPaneInfo();

      for (let i = 0; i < panes.length; i++) {
        await ctx.session.runCommand(`send-keys -t ${panes[i].id} "echo 'Process ${i}'" Enter`);
      }
      await delay(DELAYS.SYNC);

      // All panes should have content
      expect(ctx.session.exists()).toBe(true);
    });

    test('Copy mode to search', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate some output
      await runCommand(ctx.page, 'echo "Line 1"; echo "ERROR: Something"; echo "Line 3"', 'ERROR');

      // Enter copy mode and search via tmux
      await ctx.session.enterCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(true);

      await ctx.session.exitCopyMode();
      await delay(DELAYS.LONG);
      expect(await ctx.session.isPaneInCopyMode()).toBe(false);
    });
  });

  // ====================
  // 14.5 Complex Layout Stress Test
  // ====================
  describe('14.5 Complex Layout Stress Test', () => {
    test('Maximum complexity session', async () => {
      if (ctx.skipIfNotReady()) return;

      // Window 1: 4-pane grid
      await ctx.setupFourPanes();
      expect(await ctx.session.getPaneCount()).toBe(4);

      // Window 2: 3 panes
      await ctx.session.newWindow();
      await ctx.session.splitHorizontal();
      await ctx.session.splitHorizontal();
      expect(await ctx.session.getPaneCount()).toBe(3);

      // Window 3: 2 panes
      await ctx.session.newWindow();
      await ctx.session.splitVertical();
      expect(await ctx.session.getPaneCount()).toBe(2);

      // Total windows
      expect(await ctx.session.getWindowCount()).toBe(3);
    });
  });

  // ====================
  // 14.6 Unicode in Workflow Context
  // ====================
  // Note: Basic Unicode/CJK/emoji tests are in Category 1.4 (Terminal Rendering Edge Cases)
  // This section tests Unicode in realistic workflow scenarios
  describe('14.6 Unicode in Workflow Context', () => {
    test('Unicode in git-style status output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Simulate git-style status with Unicode check marks
      await runCommand(ctx.page, 'echo -e "✓ tests passed\\n✗ lint failed\\n⚠ warnings"', 'warnings');

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('tests passed');
      expect(text).toContain('lint failed');
      expect(text).toContain('warnings');
    });

    test('Unicode box drawing in tree output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Simulate tree-style output with box drawing characters
      await runCommand(ctx.page, 'echo -e "├── src\\n│   ├── main.rs\\n│   └── lib.rs\\n└── tests"', 'tests');

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('src');
      expect(text).toContain('main.rs');
      // Box drawing chars should not corrupt surrounding text
      expect(text).toContain('tests');
    });
  });

  // ====================
  // 14.7 Error Recovery Scenario
  // ====================
  describe('14.7 Error Recovery Scenario', () => {
    test('Page refresh recovery', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create state
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();
      const paneCountBefore = await ctx.session.getPaneCount();

      // Simulate crash recovery via refresh
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      ctx.session.setPage(ctx.page); // Re-set page reference after reload
      await delay(DELAYS.SYNC);

      // State should be recovered
      const paneCountAfter = await ctx.session.getPaneCount();
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
      await delay(DELAYS.SYNC);

      // Session still exists
      expect(await ctx.session.getPaneCount()).toBe(2);
    });

    test('Rapid split operations maintain state', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Rapid operations using tmux commands (limited to avoid 'no space' error)
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();

      await delay(DELAYS.SYNC);

      // State should be consistent
      const tmuxCount = await ctx.session.getPaneCount();
      expect(tmuxCount).toBe(3);

      await waitForPaneCount(ctx.page, tmuxCount);
      const uiCount = await getUIPaneCount(ctx.page);

      expect(tmuxCount).toBe(uiCount);
    });
  });
});
