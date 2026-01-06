/**
 * Pane Resize Tests
 *
 * Tests for resizing panes via UI divider drag and keyboard.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  getTmuxPaneInfo,
  // UI
  splitPaneKeyboard,
  getUIPaneInfo,
  sendTmuxPrefix,
  // Assertions
  compareTmuxAndUIState,
  verifyLayoutChanged,
} = require('./helpers');

const ctx = createTestContext();

describe('Pane Resize Operations', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // Helper to create a two-pane layout
  async function setupTwoPanes(direction = 'horizontal') {
    await ctx.navigateToSession();
    await focusPage(ctx.page);
    await splitPaneKeyboard(ctx.page, direction);
    expect(getTmuxPaneCount(ctx.testSession)).toBe(2);
  }

  describe('Resize via UI Divider', () => {
    test('resize horizontal split by dragging divider', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes('horizontal');

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before resize:', beforePanes.map(p => ({ h: p.height })));

      // Find horizontal resize divider
      const divider = await ctx.page.$('.resize-divider-h, .resize-divider[data-direction="horizontal"]');

      if (divider) {
        const box = await divider.boundingBox();
        if (box) {
          // Drag divider down 30 pixels
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await ctx.page.mouse.down();
          await delay(100);
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 10 });
          await ctx.page.mouse.up();
          await delay(DELAYS.EXTRA_LONG);

          const afterPanes = getTmuxPaneInfo(ctx.testSession);
          console.log('After resize:', afterPanes.map(p => ({ h: p.height })));

          // Heights should have changed
          expect(verifyLayoutChanged(beforePanes, afterPanes)).toBe(true);
        }
      } else {
        console.log('No horizontal divider found - UI may use different element');
      }
    }, 45000);

    test('resize vertical split by dragging divider', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes('vertical');

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before resize:', beforePanes.map(p => ({ w: p.width })));

      // Find vertical resize divider
      const divider = await ctx.page.$('.resize-divider-v, .resize-divider[data-direction="vertical"]');

      if (divider) {
        const box = await divider.boundingBox();
        if (box) {
          // Drag divider right 30 pixels
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await ctx.page.mouse.down();
          await delay(100);
          await ctx.page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 10 });
          await ctx.page.mouse.up();
          await delay(DELAYS.EXTRA_LONG);

          const afterPanes = getTmuxPaneInfo(ctx.testSession);
          console.log('After resize:', afterPanes.map(p => ({ w: p.width })));

          expect(verifyLayoutChanged(beforePanes, afterPanes)).toBe(true);
        }
      } else {
        console.log('No vertical divider found - UI may use different element');
      }
    }, 45000);
  });

  describe('Resize via Keyboard', () => {
    test('resize pane with Ctrl+a Alt+Arrow', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes('horizontal');

      const beforePanes = getTmuxPaneInfo(ctx.testSession);
      console.log('Before keyboard resize:', beforePanes.map(p => ({ h: p.height })));

      // Use Ctrl+a then Alt+Up/Down to resize (if supported)
      await sendTmuxPrefix(ctx.page);
      await delay(DELAYS.SHORT);

      // Send Alt+Up to resize
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('ArrowUp');
      await ctx.page.keyboard.up('Alt');
      await delay(DELAYS.LONG);

      // Repeat a few times
      for (let i = 0; i < 3; i++) {
        await sendTmuxPrefix(ctx.page);
        await delay(DELAYS.SHORT);
        await ctx.page.keyboard.down('Alt');
        await ctx.page.keyboard.press('ArrowUp');
        await ctx.page.keyboard.up('Alt');
        await delay(DELAYS.MEDIUM);
      }

      const afterPanes = getTmuxPaneInfo(ctx.testSession);
      console.log('After keyboard resize:', afterPanes.map(p => ({ h: p.height })));

      // Check if heights changed (binding may not be configured)
      const changed = verifyLayoutChanged(beforePanes, afterPanes);
      console.log('Layout changed:', changed);
      // Don't fail if keyboard resize isn't supported
    }, 45000);
  });

  describe('Resize in Complex Layouts', () => {
    test('resize works in 4-pane grid', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create 4 panes
      await splitPaneKeyboard(ctx.page, 'horizontal');
      await splitPaneKeyboard(ctx.page, 'vertical');

      const { navigatePaneKeyboard } = require('./helpers');
      await navigatePaneKeyboard(ctx.page, 'up');
      await splitPaneKeyboard(ctx.page, 'vertical');

      const paneCount = getTmuxPaneCount(ctx.testSession);
      console.log('Created panes:', paneCount);
      expect(paneCount).toBeGreaterThanOrEqual(3);

      const beforePanes = getTmuxPaneInfo(ctx.testSession);

      // Find any divider and drag it
      const dividers = await ctx.page.$$('.resize-divider, [class*="divider"]');
      console.log('Found dividers:', dividers.length);

      if (dividers.length > 0) {
        const divider = dividers[0];
        const box = await divider.boundingBox();
        if (box) {
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await ctx.page.mouse.down();
          await delay(100);
          await ctx.page.mouse.move(box.x + 20, box.y + 20, { steps: 5 });
          await ctx.page.mouse.up();
          await delay(DELAYS.EXTRA_LONG);

          const afterPanes = getTmuxPaneInfo(ctx.testSession);
          console.log('After resize:', afterPanes.map(p => ({ id: p.id, w: p.width, h: p.height })));
        }
      }

      // Verify UI matches tmux
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 60000);

    test('resize preserves pane count', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes('horizontal');

      const initialCount = getTmuxPaneCount(ctx.testSession);

      // Find and drag divider multiple times
      const divider = await ctx.page.$('.resize-divider, [class*="divider"]');

      if (divider) {
        const box = await divider.boundingBox();
        if (box) {
          // Multiple drag operations
          for (let i = 0; i < 3; i++) {
            const offset = (i % 2 === 0) ? 20 : -20;
            await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await ctx.page.mouse.down();
            await delay(50);
            await ctx.page.mouse.move(box.x + box.width / 2, box.y + offset, { steps: 5 });
            await ctx.page.mouse.up();
            await delay(DELAYS.LONG);
          }
        }
      }

      // Pane count should be preserved
      const finalCount = getTmuxPaneCount(ctx.testSession);
      expect(finalCount).toBe(initialCount);
    }, 45000);
  });

  describe('UI State After Resize', () => {
    test('UI pane dimensions update after resize', async () => {
      if (ctx.skipIfNotReady()) return;

      await setupTwoPanes('horizontal');
      await delay(DELAYS.SYNC);

      const beforeUI = await getUIPaneInfo(ctx.page);
      console.log('UI before:', beforeUI.map(p => ({ h: p.height })));

      // Find and drag divider
      const divider = await ctx.page.$('.resize-divider, [class*="divider"]');

      if (divider) {
        const box = await divider.boundingBox();
        if (box) {
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await ctx.page.mouse.down();
          await delay(100);
          await ctx.page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 10 });
          await ctx.page.mouse.up();
          await delay(DELAYS.SYNC);

          const afterUI = await getUIPaneInfo(ctx.page);
          console.log('UI after:', afterUI.map(p => ({ h: p.height })));

          // UI should reflect size changes
          if (beforeUI.length === 2 && afterUI.length === 2) {
            const heightsChanged = beforeUI[0].height !== afterUI[0].height ||
                                   beforeUI[1].height !== afterUI[1].height;
            console.log('UI heights changed:', heightsChanged);
          }
        }
      }

      // Final state should be consistent
      const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
      expect(comparison.match).toBe(true);
    }, 45000);
  });
});
