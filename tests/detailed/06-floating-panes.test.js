/**
 * Category 6: Floating Panes
 *
 * Tests for the simplified floating pane functionality.
 *
 * Floating panes are rendered as centered modals with a backdrop.
 * They are stored as tmux windows with names matching __float_N pattern.
 * The simplified approach uses break-pane to create floats and kill-window to close.
 * Clicking the backdrop or close button closes the float.
 */

const {
  createTestContext,
  delay,
  waitForPaneCount,
  DELAYS,
} = require('./helpers');

describe('Category 6: Floating Panes', () => {
  const ctx = createTestContext({ snapshot: true });

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  /**
   * Create a float window from the active pane using tmux break-pane.
   * This is how floats are created in the simplified approach.
   */
  async function createFloat(page, paneId) {
    const paneNum = paneId.replace('%', '');
    await ctx.session.runViaAdapter(`break-pane -d -s ${paneId} -n "__float_${paneNum}"`);
    // Float creation needs extra time for: break-pane → new window → state update → float detection
    await delay(DELAYS.SYNC);
    await delay(DELAYS.SYNC);
  }

  /**
   * Wait for a float modal to appear in the DOM.
   */
  async function waitForFloatModal(page, timeout = 10000) {
    await page.waitForSelector('.tmuxy-float-modal', { timeout });
  }

  /**
   * Get info about visible float modals.
   */
  async function getFloatModalInfo(page) {
    return await page.evaluate(() => {
      const modals = document.querySelectorAll('.tmuxy-float-modal');
      return Array.from(modals).map((modal) => ({
        hasHeader: modal.querySelector('.tmuxy-float-header') !== null,
        hasCloseButton: modal.querySelector('.tmuxy-float-close') !== null,
        hasTerminal: modal.querySelector('.tmuxy-terminal') !== null,
      }));
    });
  }

  // ====================
  // 6.1 Float Creation
  // ====================
  describe('6.1 Float Creation', () => {
    test('break-pane creates a float window in tmux', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      const paneNum = activePaneId.replace('%', '');

      await createFloat(ctx.page, activePaneId);

      // Verify a float window was created with the correct naming pattern
      const windows = await ctx.session.getWindowInfo({ includeFloats: true });
      const floatWindow = windows.find((w) => w.name === `__float_${paneNum}`);
      expect(floatWindow).toBeDefined();
    });

    test('Float modal appears after break-pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      // Verify modal is in the DOM
      const backdrop = await ctx.page.$('.tmuxy-float-backdrop');
      expect(backdrop).not.toBeNull();
    });
  });

  // ====================
  // 6.2 Float Modal Structure
  // ====================
  describe('6.2 Float Modal Structure', () => {
    test('Float modal has header with close button', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      const modalInfo = await getFloatModalInfo(ctx.page);
      expect(modalInfo.length).toBe(1);
      expect(modalInfo[0].hasHeader).toBe(true);
      expect(modalInfo[0].hasCloseButton).toBe(true);
      expect(modalInfo[0].hasTerminal).toBe(true);
    });

    test('Float reduces tiled pane count', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      const activePaneId = await ctx.session.getActivePaneId();
      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      // Tiled pane count should be reduced (pane moved to float window)
      await waitForPaneCount(ctx.page, 1);
    });
  });

  // ====================
  // 6.3 Close Float
  // ====================
  describe('6.3 Close Float', () => {
    test('Close button removes float modal and window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      const paneNum = activePaneId.replace('%', '');

      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      // Click close button
      await ctx.page.click('.tmuxy-float-close');
      await delay(DELAYS.SYNC);

      // Float modal should be gone
      const modals = await ctx.page.$$('.tmuxy-float-modal');
      expect(modals.length).toBe(0);

      // Float window should be killed in tmux
      const windows = await ctx.session.getWindowInfo();
      const floatWindow = windows.find((w) => w.name === `__float_${paneNum}`);
      expect(floatWindow).toBeUndefined();
    });

    test('Backdrop click closes float modal', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      const paneNum = activePaneId.replace('%', '');

      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      // Click on backdrop corner (outside the centered modal)
      // The modal is centered, so clicking at position (10, 10) should hit the backdrop
      const backdrop = await ctx.page.$('.tmuxy-float-backdrop');
      const box = await backdrop.boundingBox();
      await ctx.page.mouse.click(box.x + 10, box.y + 10);
      await delay(DELAYS.SYNC);

      // Float modal should be gone
      const modals = await ctx.page.$$('.tmuxy-float-modal');
      expect(modals.length).toBe(0);

      // Float window should be killed in tmux
      const windows = await ctx.session.getWindowInfo();
      const floatWindow = windows.find((w) => w.name === `__float_${paneNum}`);
      expect(floatWindow).toBeUndefined();
    });
  });

  // ====================
  // 6.4 Float Window Management
  // ====================
  describe('6.4 Float Window Management', () => {
    test('kill-window closes float', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      const activePaneId = await ctx.session.getActivePaneId();
      const paneNum = activePaneId.replace('%', '');

      // Create float via break-pane
      await createFloat(ctx.page, activePaneId);
      await waitForFloatModal(ctx.page);

      // Verify float window exists (must includeFloats to see it)
      let windows = await ctx.session.getWindowInfo({ includeFloats: true });
      const floatWindow = windows.find((w) => w.name === `__float_${paneNum}`);
      expect(floatWindow).toBeDefined();

      // Kill float window via tmux (use session:index format)
      await ctx.session.runViaAdapter(`kill-window -t ${ctx.session.name}:${floatWindow.index}`);

      // Wait for float modal to disappear
      try {
        await ctx.page.waitForFunction(
          () => document.querySelectorAll('.tmuxy-float-modal').length === 0,
          { timeout: 5000 }
        );
      } catch {
        // If timeout, modal is still present
      }

      // Float modal should be gone
      const modals = await ctx.page.$$('.tmuxy-float-modal');
      expect(modals.length).toBe(0);
    });

    // TODO: Multiple simultaneous floats require complex state coordination
    // between break-pane commands. Needs investigation of control mode timing.
    test.skip('Multiple floats stack on top of each other', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();
      expect(await ctx.session.getPaneCount()).toBe(4);

      // Get all panes and float the first two
      const allPanes = await ctx.session.getPaneInfo();
      expect(allPanes.length).toBeGreaterThanOrEqual(2);

      // Float first pane
      const pane1 = allPanes[0].id;
      await createFloat(ctx.page, pane1);
      await waitForFloatModal(ctx.page);

      // Float second pane (select it first to make it active in the original window)
      const pane2 = allPanes[1].id;
      await ctx.session.runViaAdapter(`select-pane -t ${pane2}`);
      await delay(DELAYS.SYNC);
      await createFloat(ctx.page, pane2);

      // Wait for second modal to appear
      try {
        await ctx.page.waitForFunction(
          () => document.querySelectorAll('.tmuxy-float-modal').length >= 2,
          { timeout: 10000 }
        );
      } catch {
        // If timeout, check what we have
      }

      // Should have 2 float modals
      const modals = await ctx.page.$$('.tmuxy-float-modal');
      expect(modals.length).toBe(2);

      // And 2 float windows in tmux
      const windows = await ctx.session.getWindowInfo({ includeFloats: true });
      const floatWindows = windows.filter((w) => w.name.startsWith('__float_'));
      expect(floatWindows.length).toBe(2);
    });
  });
});
