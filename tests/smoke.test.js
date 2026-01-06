/**
 * Smoke Tests
 *
 * Quick verification that all basic operations work.
 * These tests are designed to be fast and cover the essential functionality.
 */

const {
  createTestContext,
  delay,
  focusPage,
  DELAYS,
  // Tmux
  getTmuxPaneCount,
  getTmuxWindowCount,
  getActiveTmuxPane,
  isPaneZoomed,
  // UI
  splitPaneKeyboard,
  navigatePaneKeyboard,
  swapPaneKeyboard,
  toggleZoomKeyboard,
  createWindowKeyboard,
  killPaneKeyboard,
  cycleLayoutKeyboard,
  // Assertions
  compareTmuxAndUIState,
} = require('./helpers');

const ctx = createTestContext();

describe('Smoke Tests', () => {
  beforeAll(ctx.beforeAll, 60000);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('basic session loads', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();

    expect(getTmuxPaneCount(ctx.testSession)).toBe(1);
    expect(getTmuxWindowCount(ctx.testSession)).toBe(1);
  }, 30000);

  test('split pane works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');

    expect(getTmuxPaneCount(ctx.testSession)).toBe(2);
  }, 30000);

  test('navigate pane works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');

    const initial = getActiveTmuxPane(ctx.testSession);
    await navigatePaneKeyboard(ctx.page, 'up');
    const after = getActiveTmuxPane(ctx.testSession);

    expect(initial !== after).toBe(true);
  }, 30000);

  test('swap pane works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    await swapPaneKeyboard(ctx.page, 'up');

    expect(getTmuxPaneCount(ctx.testSession)).toBe(2);
  }, 30000);

  test('zoom pane works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    expect(isPaneZoomed(ctx.testSession)).toBe(false);

    await toggleZoomKeyboard(ctx.page);
    expect(isPaneZoomed(ctx.testSession)).toBe(true);

    await toggleZoomKeyboard(ctx.page);
    expect(isPaneZoomed(ctx.testSession)).toBe(false);
  }, 30000);

  test('window operations work', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    expect(getTmuxWindowCount(ctx.testSession)).toBe(1);

    await createWindowKeyboard(ctx.page);

    expect(getTmuxWindowCount(ctx.testSession)).toBe(2);
  }, 30000);

  test('layout cycle works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    await splitPaneKeyboard(ctx.page, 'vertical');

    await cycleLayoutKeyboard(ctx.page);

    expect(getTmuxPaneCount(ctx.testSession)).toBe(3);
  }, 30000);

  test('close pane works', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    expect(getTmuxPaneCount(ctx.testSession)).toBe(2);

    await killPaneKeyboard(ctx.page);

    expect(getTmuxPaneCount(ctx.testSession)).toBe(1);
  }, 30000);

  test('UI state matches tmux', async () => {
    if (ctx.skipIfNotReady()) return;

    await ctx.navigateToSession();
    await focusPage(ctx.page);

    await splitPaneKeyboard(ctx.page, 'horizontal');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await delay(DELAYS.SYNC);

    const comparison = await compareTmuxAndUIState(ctx.page, ctx.testSession);
    expect(comparison.match).toBe(true);
  }, 30000);
});
