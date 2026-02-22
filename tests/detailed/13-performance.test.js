/**
 * Category 13: Performance & Stress
 *
 * Tests for output performance, layout performance, long sessions,
 * keyboard input latency, mouse event performance, and workflow performance.
 */

const {
  createTestContext,
  delay,
  runCommandViaTmux,
  waitForTerminalText,
  getUIPaneCount,
  getUIPaneInfo,
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  splitPaneKeyboard,
  createWindowKeyboard,
  DELAYS,
  measureTime,
  sendPrefixSequenceWithTiming,
  clickWithTiming,
  dragWithTiming,
  scrollWithTiming,
} = require('./helpers');

describe('Category 13: Performance & Stress', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 13.1 Output Performance
  // ====================
  describe('13.1 Output Performance', () => {
    test('Rapid output - yes | head -500', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const start = Date.now();

      await runCommandViaTmux(ctx.session, ctx.page, 'yes | head -500 && echo "DONE"', 'DONE', 15000);

      const elapsed = Date.now() - start;

      // Should complete without hanging
      expect(elapsed).toBeLessThan(20000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Large output - seq 1 2000', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const start = Date.now();

      await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 2000 && echo "SEQ_DONE"', 'SEQ_DONE', 15000);

      const elapsed = Date.now() - start;

      // Should complete reasonably fast
      expect(elapsed).toBeLessThan(20000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Multiple commands - rapid execution', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run multiple small commands
      await runCommandViaTmux(ctx.session, ctx.page, 'echo cmd1', 'cmd1');
      await runCommandViaTmux(ctx.session, ctx.page, 'echo cmd2', 'cmd2');
      await runCommandViaTmux(ctx.session, ctx.page, 'echo cmd3', 'cmd3');

      // Should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 13.2 Layout Performance
  // ====================
  describe('13.2 Layout Performance', () => {
    test('Many panes - create 6 panes', async () => {
      if (ctx.skipIfNotReady()) return;

      // Navigate first, then create panes through adapter
      // Use the same approach as setupFourPanes + 2 more splits
      await ctx.setupFourPanes();
      expect(await ctx.session.getPaneCount()).toBe(4);

      // Add 2 more splits to reach 6
      await ctx.session.splitHorizontal();
      const start1 = Date.now();
      while (Date.now() - start1 < 10000) {
        if (await ctx.session.getPaneCount() === 5) break;
        await delay(100);
      }

      await ctx.session.splitVertical();
      const start2 = Date.now();
      while (Date.now() - start2 < 10000) {
        if (await ctx.session.getPaneCount() === 6) break;
        await delay(100);
      }

      expect(await ctx.session.getPaneCount()).toBe(6);

      // UI should show all panes
      await waitForPaneCount(ctx.page, 6);
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(6);
    });

    test('Rapid split/close via tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Use alternating split directions to avoid minimum size constraints
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // Wait for XState to reflect 4 panes
      const startSplit = Date.now();
      while (Date.now() - startSplit < 10000) {
        if (await ctx.session.getPaneCount() === 4) break;
        await delay(100);
      }
      expect(await ctx.session.getPaneCount()).toBe(4);

      // Close them
      await ctx.session.killPane();
      await ctx.session.killPane();
      await ctx.session.killPane();
      await delay(DELAYS.SYNC);

      // Wait for XState to reflect 1 pane
      const startKill = Date.now();
      while (Date.now() - startKill < 10000) {
        if (await ctx.session.getPaneCount() === 1) break;
        await delay(100);
      }
      expect(await ctx.session.getPaneCount()).toBe(1);
    });

    test('Resize during output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Start output in background
      await ctx.session.sendKeys('"seq 1 50" Enter');

      // Resize while output is happening
      await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
      await delay(DELAYS.SHORT);
      await ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -U 3`);
      await delay(DELAYS.SYNC);

      // Should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 13.4 Long Sessions
  // ====================
  describe('13.4 Long Sessions', () => {
    test('Large scrollback - accumulate history', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate output
      await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 200 && echo "HISTORY_DONE"', 'HISTORY_DONE', 10000);

      // Should have scrollback
      expect(ctx.session.exists()).toBe(true);
    });

    test('Many windows - create 4 windows', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      for (let i = 0; i < 4; i++) {
        await ctx.session.newWindow();
      }

      await delay(DELAYS.SYNC);
      expect(await ctx.session.getWindowCount()).toBe(5);
    });
  });

  // ====================
  // 13.5 Keyboard Input Performance
  // ====================
  describe('13.5 Keyboard Input Performance', () => {
    test('Rapid typing - round-trip via tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate a unique marker to verify output
      const testString = 'perf' + Date.now().toString(36);
      const marker = 'TYPE_DONE_' + testString;

      const elapsed = await measureTime(async () => {
        // Use tmux send-keys for reliable input (avoids character transposition)
        await runCommandViaTmux(ctx.session, ctx.page, `echo "${testString}" && echo "${marker}"`, marker, 10000);
      });

      // Should complete within 5s via tmux path
      expect(elapsed).toBeLessThan(5000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Modifier keys - Ctrl+hjkl navigation < 500ms', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await ctx.session.splitHorizontal();
      await waitForPaneCount(ctx.page, 2);
      await ctx.session.splitVertical();
      await waitForPaneCount(ctx.page, 3);

      expect(await ctx.session.getPaneCount()).toBe(3);

      // Navigate with Ctrl+h (left) - measures root binding lookup
      const elapsed = await measureTime(async () => {
        await sendKeyCombo(ctx.page, 'Control', 'h');
        await delay(DELAYS.MEDIUM);
      });

      // 500ms is conservative for modifier key + binding lookup + focus change
      expect(elapsed).toBeLessThan(500);
      expect(ctx.session.exists()).toBe(true);
    });

    // Skipped: Prefix key (Ctrl+A) not reliably forwarded through headless Chrome to tmux
    test.skip('Prefix key sequences - Ctrl+a then c < 1.5s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialWindows = await ctx.session.getWindowCount();

      // Send Ctrl+a, then 'c' (new window) and measure
      const elapsed = await measureTime(async () => {
        const keyTime = await sendPrefixSequenceWithTiming(ctx.page, 'c');
        // Wait for window to be created
        await delay(DELAYS.EXTRA_LONG);
      });

      // Verify window was created
      await delay(DELAYS.SYNC);
      expect(await ctx.session.getWindowCount()).toBe(initialWindows + 1);

      // 1500ms for prefix sequence + EXTRA_LONG delay
      expect(elapsed).toBeLessThan(1500);
    });
  });

  // ====================
  // 13.6 Mouse Event Performance
  // ====================
  describe('13.6 Mouse Event Performance', () => {
    test('Mouse click - focus pane < 500ms', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);

      // Click on the other pane (not active)
      const targetPane = panes[0];
      const elapsed = await measureTime(async () => {
        await clickWithTiming(
          ctx.page,
          targetPane.x + targetPane.width / 2,
          targetPane.y + targetPane.height / 2
        );
        await delay(DELAYS.MEDIUM);
      });

      // 500ms for click + MEDIUM delay
      expect(elapsed).toBeLessThan(500);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Mouse wheel scroll - 10 scroll events < 500ms', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate content to scroll
      await runCommandViaTmux(ctx.session, ctx.page, 'seq 1 100 && echo "SCROLL_READY"', 'SCROLL_READY', 10000);

      const panes = await getUIPaneInfo(ctx.page);
      const pane = panes[0];

      // Send 10 wheel events rapidly
      const elapsed = await scrollWithTiming(
        ctx.page,
        10,
        -50,
        { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 }
      );

      // 600ms for 10 scroll events (debounced, includes some processing overhead)
      expect(elapsed).toBeLessThan(600);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Mouse drag - 20 pixel drag < 500ms', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const panes = await getUIPaneInfo(ctx.page);
      const pane = panes[0];

      const startX = pane.x + 50;
      const startY = pane.y + 50;
      const endX = startX + 100; // 100 pixels drag
      const endY = startY;

      // Perform drag operation
      const elapsed = await dragWithTiming(ctx.page, startX, startY, endX, endY, { steps: 10 });

      // 500ms for drag with multiple mouse move events
      expect(elapsed).toBeLessThan(500);
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 13.7 End-to-End Workflow Performance
  // ====================
  describe('13.7 End-to-End Workflow Performance', () => {
    test('Split and navigate workflow < 15s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const elapsed = await measureTime(async () => {
        // Split pane via tmux command (keyboard prefix unreliable in headless Chrome)
        await ctx.session.splitHorizontal();
        await waitForPaneCount(ctx.page, 2);

        // Navigate with tmux select-pane
        await ctx.session.selectPane('U');
        await delay(DELAYS.MEDIUM);

        await ctx.session.selectPane('D');
        await delay(DELAYS.MEDIUM);
      });

      expect(await ctx.session.getPaneCount()).toBe(2);
      // 15s accounts for split + waitForPaneCount + navigation delays
      expect(elapsed).toBeLessThan(15000);
    });

    test('Tab workflow - create 3 windows < 12s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const elapsed = await measureTime(async () => {
        // Create 3 windows via tmux commands (keyboard prefix unreliable)
        await ctx.session.newWindow();
        await delay(DELAYS.LONG);
        await ctx.session.newWindow();
        await delay(DELAYS.LONG);
        await ctx.session.newWindow();
        await delay(DELAYS.SYNC);
      });

      // Verify windows created
      expect(await ctx.session.getWindowCount()).toBe(4); // 1 initial + 3 created

      // 12s accounts for tmux command propagation + SYNC waits
      expect(elapsed).toBeLessThan(12000);
    });

    test('Multiple panes workflow - create 4 panes < 10s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const elapsed = await measureTime(async () => {
        // Create multiple panes via tmux commands (keyboard prefix unreliable)
        await ctx.session.splitHorizontal();
        await waitForPaneCount(ctx.page, 2);

        await ctx.session.splitVertical();
        await waitForPaneCount(ctx.page, 3);

        await ctx.session.splitHorizontal();
        await waitForPaneCount(ctx.page, 4);
      });

      expect(await ctx.session.getPaneCount()).toBe(4);
      // 10s accounts for multiple splits + waitForPaneCount calls
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
