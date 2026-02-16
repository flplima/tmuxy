/**
 * Category 15: Glitch Detection
 *
 * Tests for detecting unintended DOM mutations (flicker, layout shifts,
 * attribute churn, size jumps) during critical UI state transitions.
 *
 * These tests use MutationObserver + size polling (60fps) to catch visual
 * instability that functional tests and snapshot comparisons miss.
 *
 * Detection types:
 * - Node flicker: Element added then removed (or vice versa) within 100ms
 * - Attribute churn: Same attribute changing >2x within 200ms
 * - Size jumps: Pane dimensions changing >20px unexpectedly
 */

const {
  createTestContext,
  delay,
  getUIPaneCount,
  waitForPaneCount,
  splitPaneKeyboard,
  sendKeyCombo,
  GlitchDetector,
  DELAYS,
} = require('./helpers');

describe('Category 15: Glitch Detection', () => {
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

      // Use tmux split for reliability - the split itself triggers UI update we're testing
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

      // Use tmux split for reliability
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

      // Create split via tmux before navigation (more reliable)
      ctx.session.splitHorizontal();
      expect(await ctx.session.getPaneCount()).toBe(2);

      await ctx.setupPage();
      await waitForPaneCount(ctx.page, 2, 20000);
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({
        scope: '.pane-container',
        sizeJumpThreshold: 100,
        // Resize dividers are recreated during resize
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

      // Create split via tmux before navigation
      ctx.session.splitHorizontal();
      expect(await ctx.session.getPaneCount()).toBe(2);

      await ctx.setupPage();
      await waitForPaneCount(ctx.page, 2, 20000);
      await delay(DELAYS.SYNC);

      await ctx.startGlitchDetection({ scope: '.pane-container' });

      // Get pane positions and click
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

      const result = await ctx.assertNoGlitches({ operation: 'default' });
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

      // Verify the detector captured data
      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.nodeFlickers).toBeDefined();
      expect(result.summary.attrChurnEvents).toBeDefined();
      expect(result.summary.sizeJumps).toBeDefined();
      expect(result.summary.totalNodeMutations).toBeGreaterThanOrEqual(0);
      expect(result.summary.duration).toBeGreaterThan(0);

      // Verify arrays are populated
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

      // Trigger terminal content mutations (not ignored by default)
      await ctx.session.sendKeys('"echo formatTimeline test" Enter');
      await delay(DELAYS.LONG);

      const result = await detector.stop();
      const timeline = GlitchDetector.formatTimeline(result);

      expect(typeof timeline).toBe('string');
      // Timeline includes nodes and attributes (not sizes), so check those specifically
      if (result.nodes.length > 0 || result.attributes.length > 0) {
        expect(timeline).toMatch(/\+\d+ms/);
      } else {
        // No node/attr mutations - timeline will be empty (sizes aren't included)
        expect(timeline).toBe('');
      }
    }, 90000);

    test('GlitchDetector can be stopped without assertions', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();
      await delay(DELAYS.SYNC);

      const detector = new GlitchDetector(ctx.page);
      await detector.start({ scope: '.pane-container' });

      // Just stop without doing anything
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

      // Type some content to trigger terminal mutations
      await ctx.session.sendKeys('"echo ignoreSelectors test" Enter');
      await delay(DELAYS.LONG);

      const result = await detector.stop();

      // Terminal content mutations should be filtered out
      const terminalMutations = result.nodes.filter(n =>
        n.element?.includes('terminal') || n.target?.includes('terminal')
      );
      expect(terminalMutations.length).toBe(0);
    }, 90000);
  });
});
