/**
 * Stress & Stability E2E Tests
 *
 * Large output perf, rapid operations, complex workflow, glitch detection
 * (scenario-level and detailed).
 */

const {
  createTestContext,
  delay,
  runCommand,
  getUIPaneCount,
  sendKeyCombo,
  waitForPaneCount,
  waitForWindowCount,
  withConsistencyChecks,
  verifyDomSizes,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  swapPaneKeyboard,
  toggleZoomKeyboard,
  createWindowKeyboard,
  selectWindowKeyboard,
  killPaneKeyboard,
  resizePaneKeyboard,
  GlitchDetector,
  DELAYS,
} = require('./helpers');

// ==================== Scenario 17: Large Output Perf ====================

describe('Scenario 17: Large Output Perf', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('yes|head-500 → seq 1 2000 → scrollback → verify responsive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Rapid output (yes | head -500)
    const start1 = Date.now();
    await runCommand(ctx.page, 'yes | head -500 && echo DONE_YES', 'DONE_YES', 20000);
    const elapsed1 = Date.now() - start1;
    expect(elapsed1).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 2: Large output (seq 1 2000)
    const start2 = Date.now();
    await runCommand(ctx.page, 'seq 1 2000 && echo SEQ_DONE', 'SEQ_DONE', 20000);
    const elapsed2 = Date.now() - start2;
    expect(elapsed2).toBeLessThan(20000);
    expect(ctx.session.exists()).toBe(true);

    // Step 3: Large scrollback accumulation
    await runCommand(ctx.page, 'for i in $(seq 1 200); do echo "line_$i"; done && echo SCROLL_DONE', 'SCROLL_DONE', 15000);
    expect(ctx.session.exists()).toBe(true);

    // Step 4: Verify responsive
    await runCommand(ctx.page, 'echo "STILL_RESPONSIVE"', 'STILL_RESPONSIVE');
  }, 180000);
});

// ==================== Scenario 18: Rapid Operations ====================

describe('Scenario 18: Rapid Operations', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Split×4 → kill×3 → split-close-split → 6 panes → 4 windows → swap', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Rapid splits ×4 (wait for each split to complete via XState)
    async function splitAndWait(direction, expectedCount) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await splitPaneKeyboard(ctx.page, direction);
        const waitTime = 10000 + attempt * 5000;
        const ok = await waitForPaneCount(ctx.page, expectedCount, waitTime);
        if (ok) return;
        const tmuxCount = await ctx.session.getPaneCount();
        if (tmuxCount >= expectedCount) {
          await waitForPaneCount(ctx.page, expectedCount, 5000);
          return;
        }
        await delay(DELAYS.SYNC);
      }
      expect(await ctx.session.getPaneCount()).toBe(expectedCount);
    }
    await splitAndWait('horizontal', 2);
    await splitAndWait('vertical', 3);
    await splitAndWait('horizontal', 4);
    await splitAndWait('vertical', 5);
    expect(await ctx.session.getPaneCount()).toBe(5);

    // Step 2: Kill ×3
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Split-close-split
    const result = await withConsistencyChecks(ctx, async () => {
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await delay(DELAYS.SYNC);
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.SYNC);
      await splitPaneKeyboard(ctx.page, 'vertical');
      await delay(DELAYS.SYNC);
    }, { operationType: 'split' });
    expect(await ctx.session.getPaneCount()).toBe(3);
    expect(result.glitch.summary.nodeFlickers).toBeLessThanOrEqual(4);

    // Kill to reset
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await killPaneKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 4: 6-pane grid
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3, 10000);
    await navigatePaneKeyboard(ctx.page, 'up');
    await navigatePaneKeyboard(ctx.page, 'up');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 4, 10000);
    await navigatePaneKeyboard(ctx.page, 'down');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 5, 10000);
    await navigatePaneKeyboard(ctx.page, 'down');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 6, 10000);
    expect(await ctx.session.getPaneCount()).toBe(6);
    const sizeResult = await verifyDomSizes(ctx.page);
    expect(sizeResult.valid).toBe(true);

    // Kill back to 1 pane for next steps
    for (let i = 0; i < 5; i++) {
      await killPaneKeyboard(ctx.page);
      await delay(DELAYS.SYNC);
    }
    expect(await ctx.session.getPaneCount()).toBe(1);

    // Step 5: 4 windows — wait for each before creating the next
    await waitForWindowCount(ctx.page, 1, 5000);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2, 10000);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 3, 10000);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 4, 10000);
    expect(await ctx.session.getWindowCount()).toBe(4);

    // Step 6: Swap panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    const panesBefore = await ctx.session.getPaneInfo();
    const firstPaneIdBefore = panesBefore[0].id;
    await swapPaneKeyboard(ctx.page, 'down');
    await delay(DELAYS.SYNC);
    const panesAfterSwap = await ctx.session.getPaneInfo();
    expect(panesAfterSwap[0].id !== firstPaneIdBefore ||
           panesAfterSwap[0].y !== panesBefore[0].y).toBe(true);
  }, 240000);
});

// ==================== Scenario 19: Complex Workflow ====================

describe('Scenario 19: Complex Workflow', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('3 windows × splits → navigate all → send commands → verify alive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Window 1 with 3 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);
    expect(await ctx.session.getPaneCount()).toBe(3);

    // Step 2: Window 2 with 2 panes
    await createWindowKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Window 3 with 2 panes
    await createWindowKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 1, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Verify 3 windows exist
    const pollStart = Date.now();
    while (Date.now() - pollStart < 10000) {
      const wc = await ctx.session.getWindowCount();
      if (wc >= 3) break;
      await delay(DELAYS.MEDIUM);
    }
    expect(await ctx.session.getWindowCount()).toBeGreaterThanOrEqual(3);

    // Step 5: Navigate through all windows
    const windowInfo = await ctx.session.getWindowInfo();
    for (const w of windowInfo) {
      await selectWindowKeyboard(ctx.page, w.index);
      await delay(DELAYS.LONG);
    }

    // Step 6: Send commands to verify panes alive
    await selectWindowKeyboard(ctx.page, windowInfo[0].index);
    await delay(DELAYS.LONG);
    await runCommand(ctx.page, 'echo "WIN1_OK"', 'WIN1_OK');

    // Step 7: Zoom and unzoom
    await toggleZoomKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(true);
    await toggleZoomKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    expect(await ctx.session.isPaneZoomed()).toBe(false);

    // Step 8: Navigate windows rapidly
    for (const w of windowInfo) {
      await selectWindowKeyboard(ctx.page, w.index);
      await delay(DELAYS.SHORT);
    }
    expect(ctx.session.exists()).toBe(true);
  }, 180000);
});

// ==================== Scenario 20: Glitch Detection ====================

describe('Scenario 20: Glitch Detection', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Split H + detect → split V + detect → resize + detect → click focus + detect', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Horizontal split with glitch detection
    await ctx.startGlitchDetection({ scope: '.pane-container' });
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    await delay(DELAYS.SYNC);
    let result = await ctx.assertNoGlitches({ operation: 'split' });

    // Step 2: Vertical split with glitch detection
    await ctx.startGlitchDetection({
      scope: '.pane-container',
      ignoreSelectors: ['.resize-divider'],
      sizeJumpThreshold: 30,
    });
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3);
    await delay(DELAYS.SYNC);
    result = await ctx.assertNoGlitches({ operation: 'split' });

    // Kill to get back to 2 panes for resize test
    await killPaneKeyboard(ctx.page);
    await waitForPaneCount(ctx.page, 2, 10000);

    // Step 3: Resize with glitch detection
    await ctx.startGlitchDetection({
      scope: '.pane-container',
      sizeJumpThreshold: 100,
      ignoreSelectors: ['.terminal-content', '.terminal-line', '.terminal-cursor', '.resize-divider'],
    });
    await resizePaneKeyboard(ctx.page, 'D', 5);
    await delay(DELAYS.SYNC);
    const resizeResult = await ctx.assertNoGlitches({ operation: 'resize', sizeJumps: 20 });
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Click focus with glitch detection
    await ctx.startGlitchDetection({ scope: '.pane-container' });
    const paneInfo = await ctx.page.evaluate(() => {
      const panes = document.querySelectorAll('.pane-layout-item');
      return Array.from(panes).map(p => {
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    });
    if (paneInfo.length >= 2) {
      await ctx.page.mouse.click(paneInfo[1].x, paneInfo[1].y);
      await delay(DELAYS.SYNC);
    }
    // Click focus triggers CSS layout transitions, causing size jumps
    const clickResult = await ctx.assertNoGlitches({ operation: 'split', sizeJumps: 30 });
  }, 180000);
});

// ==================== Detailed Glitch Detection Tests ====================

describe('Category 15: Glitch Detection (Detailed)', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    // Ensure glitch detector is cleaned up even on test failure
    if (ctx.glitchDetector?.isRunning) {
      try {
        await ctx.glitchDetector.stop();
      } catch (e) {
        // Ignore cleanup errors
      }
      ctx.glitchDetector = null;
    }
    await ctx.afterEach();
  });

  // ====================
  // 15.1 Pane Split Operations
  // ====================
  describe('15.1 Pane Split Operations', () => {
    test('Horizontal split produces no flicker', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({ scope: '.pane-container' });

      ctx.session.splitHorizontal();
      await waitForPaneCount(ctx.page, 2, 20000);
      await delay(DELAYS.SYNC);

      const result = await ctx.assertNoGlitches({ operation: 'split' });
      expect(await getUIPaneCount(ctx.page)).toBe(2);
      expect(await ctx.session.getPaneCount()).toBe(2);

      if (process.env.DEBUG_TESTS) {
        console.log(`Split mutations: ${result.summary.totalNodeMutations} nodes`);
      }
    }, 90000);

    test('Vertical split produces no flicker', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({ scope: '.pane-container' });

      ctx.session.splitVertical();
      await waitForPaneCount(ctx.page, 2, 20000);
      await delay(DELAYS.SYNC);

      const result = await ctx.assertNoGlitches({ operation: 'split' });
      expect(await getUIPaneCount(ctx.page)).toBe(2);
      expect(await ctx.session.getPaneCount()).toBe(2);
    }, 90000);
  });

  // ====================
  // 15.2 Pane Resize Operations
  // ====================
  describe('15.2 Pane Resize Operations', () => {
    test('Resize via tmux command produces no unexpected flicker', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({
        scope: '.pane-container',
        sizeJumpThreshold: 100,
        ignoreSelectors: ['.terminal-content', '.terminal-line', '.terminal-cursor', '.resize-divider'],
      });

      ctx.session.runCommand(`resize-pane -t ${ctx.session.name} -D 5`);
      await delay(DELAYS.SYNC);

      const result = await ctx.assertNoGlitches({
        operation: 'resize',
        sizeJumps: 20,
      });

      expect(await ctx.session.getPaneCount()).toBe(2);
    }, 90000);
  });

  // ====================
  // 15.3 Click Focus Operations
  // ====================
  describe('15.3 Click Focus Operations', () => {
    test('Click to focus pane produces no flicker', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({ scope: '.pane-container' });

      const paneInfo = await ctx.page.evaluate(() => {
        const panes = document.querySelectorAll('.pane-layout-item');
        return Array.from(panes).map(p => {
          const rect = p.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        });
      });

      if (paneInfo.length >= 2) {
        await ctx.page.mouse.click(paneInfo[1].x, paneInfo[1].y);
        await delay(DELAYS.SYNC);
      }

      const result = await ctx.assertNoGlitches({ operation: 'split', sizeJumps: 30 });
    }, 90000);
  });

  // ====================
  // 15.4 GlitchDetector API Tests
  // ====================
  describe('15.4 GlitchDetector API', () => {
    test('GlitchDetector captures mutations during split', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      const detector = new GlitchDetector(ctx.page);
      await detector.start({ scope: '.pane-container' });

      await splitPaneKeyboard(ctx.page, 'horizontal');
      await waitForPaneCount(ctx.page, 2, 20000);
      await delay(DELAYS.SHORT);

      const result = await detector.stop();

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.nodeFlickers).toBeDefined();
      expect(result.summary.attrChurnEvents).toBeDefined();
      expect(result.summary.sizeJumps).toBeDefined();
      expect(result.summary.totalNodeMutations).toBeGreaterThanOrEqual(0);
      expect(result.summary.duration).toBeGreaterThan(0);

      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.attributes)).toBe(true);
      expect(Array.isArray(result.sizes)).toBe(true);
    }, 90000);

    test('GlitchDetector.formatTimeline produces readable output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      const detector = new GlitchDetector(ctx.page);
      await detector.start({ scope: '.pane-container' });

      await ctx.session.sendKeys('"echo formatTimeline test" Enter');
      await delay(DELAYS.LONG);

      const result = await detector.stop();
      const timeline = GlitchDetector.formatTimeline(result);

      expect(typeof timeline).toBe('string');
      if (result.nodes.length > 0 || result.attributes.length > 0) {
        expect(timeline).toMatch(/\+\d+ms/);
      } else {
        expect(timeline).toBe('');
      }
    }, 90000);

    test('GlitchDetector can be stopped without assertions', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      const detector = new GlitchDetector(ctx.page);
      await detector.start({ scope: '.pane-container' });

      const result = await detector.stop();

      expect(result).toBeDefined();
      expect(result.summary.duration).toBeGreaterThanOrEqual(0);
    }, 90000);

    test('GlitchDetector respects ignoreSelectors', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      const detector = new GlitchDetector(ctx.page);
      await detector.start({
        scope: '.pane-container',
        ignoreSelectors: ['.terminal-content', '.terminal-line', '.terminal-cursor'],
      });

      await ctx.session.sendKeys('"echo ignoreSelectors test" Enter');
      await delay(DELAYS.LONG);

      const result = await detector.stop();

      const terminalMutations = result.nodes.filter(n =>
        n.element?.includes('terminal') || n.target?.includes('terminal')
      );
      expect(terminalMutations.length).toBe(0);
    }, 90000);
  });
});
