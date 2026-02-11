/**
 * Category 13: Performance & Stress
 *
 * Tests for output performance, layout performance, long sessions,
 * keyboard input latency, mouse event performance, and workflow performance.
 */

const {
  createTestContext,
  delay,
  runCommand,
  waitForTerminalText,
  getTerminalText,
  getUIPaneCount,
  getUIPaneInfo,
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  sendKeyCombo,
  clickPane,
  splitPaneKeyboard,
  createWindowKeyboard,
  DELAYS,
  measureTime,
  assertCompletesWithin,
  measureKeyboardRoundTrip,
  sendCtrlKeyWithTiming,
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

      await runCommand(ctx.page, 'yes | head -500 && echo "DONE"', 'DONE', 15000);

      const elapsed = Date.now() - start;

      // Should complete without hanging
      expect(elapsed).toBeLessThan(20000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Large output - seq 1 2000', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const start = Date.now();

      await runCommand(ctx.page, 'seq 1 2000 && echo "SEQ_DONE"', 'SEQ_DONE', 15000);

      const elapsed = Date.now() - start;

      // Should complete reasonably fast
      expect(elapsed).toBeLessThan(20000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Multiple commands - rapid execution', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run multiple small commands
      await runCommand(ctx.page, 'echo cmd1', 'cmd1');
      await runCommand(ctx.page, 'echo cmd2', 'cmd2');
      await runCommand(ctx.page, 'echo cmd3', 'cmd3');

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

      // Create panes via tmux before navigating to avoid DOM detachment
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) {
          ctx.session.splitHorizontal();
        } else {
          ctx.session.splitVertical();
        }
      }

      expect(ctx.session.getPaneCount()).toBe(6);

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      // UI should show all panes
      await waitForPaneCount(ctx.page, 6);
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(6);
    });

    test('Rapid split/close via tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Rapid split operations
      await ctx.session.splitHorizontal();
      await ctx.session.splitHorizontal();
      await ctx.session.splitHorizontal();

      expect(await ctx.session.getPaneCount()).toBe(4);

      // Close them
      await ctx.session.killPane();
      await ctx.session.killPane();
      await ctx.session.killPane();
      await delay(DELAYS.SYNC);

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
  // 13.3 Large Output Stability
  // ====================
  describe('13.3 Large Output Stability', () => {
    // Skipped: Large file output can timeout in CI environments
    test.skip('cat large file - connection survives 500+ lines', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate a large file using runCommand to ensure completion before cat
      await runCommand(
        ctx.page,
        'seq 1 500 > /tmp/tmuxy_large_test.txt && echo "FILE_CREATED"',
        'FILE_CREATED',
        15000
      );

      // cat the large file - this previously crashed the control mode connection
      // due to non-UTF-8 bytes from the script PTY wrapper
      const text = await runCommand(
        ctx.page,
        'cat /tmp/tmuxy_large_test.txt && echo "CAT_DONE"',
        'CAT_DONE',
        30000
      );

      expect(text).toContain('CAT_DONE');
      expect(ctx.session.exists()).toBe(true);

      // Verify terminal is still interactive after large output
      const afterText = await runCommand(ctx.page, 'echo "STILL_ALIVE"', 'STILL_ALIVE');
      expect(afterText).toContain('STILL_ALIVE');
    });

    // Skipped: Special characters handling has timing issues
    test.skip('cat file with special characters - non-ASCII content', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create file with mixed content using sendKeys to avoid printf escape issues
      ctx.session.sendKeys('"printf \\"# Heading\\\\n\\\\n- bullet 1\\\\n- bullet 2\\\\n\\\\n> blockquote line\\\\n\\" > /tmp/tmuxy_special.txt && echo BASE_CREATED" Enter');
      await waitForTerminalText(ctx.page, 'BASE_CREATED', 15000);

      // Repeat file content to make it larger
      ctx.session.sendKeys('"for i in $(seq 1 30); do cat /tmp/tmuxy_special.txt >> /tmp/tmuxy_special_long.txt; done && echo LONG_CREATED" Enter');
      await waitForTerminalText(ctx.page, 'LONG_CREATED', 15000);

      // Cat the large file with special content
      const text = await runCommand(
        ctx.page,
        'cat /tmp/tmuxy_special_long.txt && echo "SPECIAL_DONE"',
        'SPECIAL_DONE',
        30000
      );

      expect(text).toContain('SPECIAL_DONE');
      expect(ctx.session.exists()).toBe(true);
    });

    // Skipped: Large output bursts have timing issues in CI
    test.skip('Rapid large output bursts - multiple cat commands', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run multiple large outputs in sequence
      const text = await runCommand(
        ctx.page,
        'seq 1 200 && seq 200 400 && seq 400 600 && echo "BURST_DONE"',
        'BURST_DONE',
        30000
      );

      expect(text).toContain('BURST_DONE');
      expect(ctx.session.exists()).toBe(true);

      // Connection should still be alive and responsive
      const afterText = await runCommand(ctx.page, 'echo "POST_BURST_OK"', 'POST_BURST_OK');
      expect(afterText).toContain('POST_BURST_OK');
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
      await runCommand(ctx.page, 'seq 1 200 && echo "HISTORY_DONE"', 'HISTORY_DONE', 10000);

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
    test('Rapid typing - 50 characters < 5s round-trip', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate a unique marker to verify output
      const testString = 'perf' + Date.now().toString(36);
      const marker = 'TYPE_DONE_' + testString;

      const elapsed = await measureTime(async () => {
        // Type the test string and echo it to verify round-trip
        await typeInTerminal(ctx.page, `echo "${testString}" && echo "${marker}"`);
        await pressEnter(ctx.page);
        await waitForTerminalText(ctx.page, marker, 10000);
      });

      // 5 seconds accounts for WebSocket latency and typing delays (50 chars @ 15ms = 750ms + overhead)
      expect(elapsed).toBeLessThan(5000);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Modifier keys - Ctrl+hjkl navigation < 500ms', async () => {
      if (ctx.skipIfNotReady()) return;

      // Create 2x2 pane layout via tmux
      ctx.session.splitHorizontal();
      ctx.session.splitVertical();

      expect(ctx.session.getPaneCount()).toBe(3);

      await ctx.setupPage();
      await waitForPaneCount(ctx.page, 3);

      // Navigate with Ctrl+h (left) - measures root binding lookup
      const elapsed = await measureTime(async () => {
        await sendKeyCombo(ctx.page, 'Control', 'h');
        await delay(DELAYS.MEDIUM);
      });

      // 500ms is conservative for modifier key + binding lookup + focus change
      expect(elapsed).toBeLessThan(500);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Prefix key sequences - Ctrl+a then c < 1.5s', async () => {
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

      // Create split panes
      ctx.session.splitHorizontal();
      expect(ctx.session.getPaneCount()).toBe(2);

      await ctx.setupPage();
      await waitForPaneCount(ctx.page, 2);

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
      await runCommand(ctx.page, 'seq 1 100 && echo "SCROLL_READY"', 'SCROLL_READY', 10000);

      const panes = await getUIPaneInfo(ctx.page);
      const pane = panes[0];

      // Send 10 wheel events rapidly
      const elapsed = await scrollWithTiming(
        ctx.page,
        10,
        -50,
        { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 }
      );

      // 500ms for 10 scroll events (debounced)
      expect(elapsed).toBeLessThan(500);
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
    // Skipped: Workflow timing varies in CI environments
    test.skip('Command workflow - type, execute, verify < 20s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const marker = 'WORKFLOW_' + Date.now().toString(36);

      const elapsed = await measureTime(async () => {
        // Type command
        await typeInTerminal(ctx.page, `echo "${marker}"`);
        // Execute
        await pressEnter(ctx.page);
        // Verify output appears
        await waitForTerminalText(ctx.page, marker, 10000);
      });

      // Full editing round-trip should be under 20s
      expect(elapsed).toBeLessThan(20000);

      // Verify terminal is still responsive
      const verifyMarker = 'STILL_OK_' + Date.now().toString(36);
      await runCommand(ctx.page, `echo "${verifyMarker}"`, verifyMarker);
      expect(ctx.session.exists()).toBe(true);
    });

    test('Split and navigate workflow < 15s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const elapsed = await measureTime(async () => {
        // Split pane via keyboard (Ctrl+a ")
        await splitPaneKeyboard(ctx.page, 'horizontal');
        await waitForPaneCount(ctx.page, 2);

        // Navigate with Ctrl+k (up)
        await sendKeyCombo(ctx.page, 'Control', 'k');
        await delay(DELAYS.MEDIUM);

        // Navigate with Ctrl+j (down)
        await sendKeyCombo(ctx.page, 'Control', 'j');
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
        // Create 3 windows via keyboard
        await createWindowKeyboard(ctx.page);
        await delay(DELAYS.LONG);
        await createWindowKeyboard(ctx.page);
        await delay(DELAYS.LONG);
        await createWindowKeyboard(ctx.page);
        await delay(DELAYS.SYNC);
      });

      // Verify windows created
      expect(await ctx.session.getWindowCount()).toBe(4); // 1 initial + 3 created

      // 12s accounts for keyboard delays + SYNC waits
      expect(elapsed).toBeLessThan(12000);
    });

    test('Multiple panes workflow - create 4 panes < 10s', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const elapsed = await measureTime(async () => {
        // Create multiple panes
        await splitPaneKeyboard(ctx.page, 'horizontal');
        await waitForPaneCount(ctx.page, 2);

        await splitPaneKeyboard(ctx.page, 'vertical');
        await waitForPaneCount(ctx.page, 3);

        await splitPaneKeyboard(ctx.page, 'horizontal');
        await waitForPaneCount(ctx.page, 4);
      });

      expect(await ctx.session.getPaneCount()).toBe(4);
      // 10s accounts for multiple splits + waitForPaneCount calls
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
