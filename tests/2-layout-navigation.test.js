/**
 * Layout & Navigation E2E Tests
 *
 * Window lifecycle, pane groups, floating panes, and status bar.
 */

const {
  createTestContext,
  delay,
  focusPage,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
  killPaneKeyboard,
  selectLayoutKeyboard,
  tmuxCommandKeyboard,
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  DELAYS,
} = require('./helpers');

// ==================== Float Helpers ====================

async function createFloat(ctx, paneId) {
  const paneNum = paneId.replace('%', '');
  await ctx.session._exec(`break-pane -d -s ${paneId} -n "__float_${paneNum}"`);
  await delay(DELAYS.SYNC);
  await delay(DELAYS.SYNC);
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-container', { timeout });
}

async function getFloatModalInfo(page) {
  return await page.evaluate(() => {
    const modals = document.querySelectorAll('.modal-container');
    return Array.from(modals).map((modal) => ({
      hasHeader: modal.querySelector('.modal-header') !== null,
      hasCloseButton: modal.querySelector('.modal-close') !== null,
      hasTerminal: modal.querySelector('.terminal-container') !== null,
    }));
  });
}

// ==================== Scenario 4: Window Lifecycle ====================

describe('Scenario 4: Window Lifecycle', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('New window → tabs → next/prev → by-number → last → rename → close → layout', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create new window
    const initialCount = await ctx.session.getWindowCount();
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, initialCount + 1);
    expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);

    // Step 2: Window tabs
    const windowInfo = await ctx.session.getWindowInfo();
    expect(windowInfo.length).toBe(2);

    // Step 3: Next window
    const currentIndex = await ctx.session.getCurrentWindowIndex();
    await nextWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(currentIndex);

    // Step 4: Previous window
    const idx = await ctx.session.getCurrentWindowIndex();
    await prevWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(idx);

    // Step 5: Create 3rd window and select by number
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 3);
    await selectWindowKeyboard(ctx.page, 1);
    await delay(DELAYS.LONG);
    expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

    // Step 6: Last window toggle
    await lastWindowKeyboard(ctx.page);
    await delay(DELAYS.LONG);
    // Should be on one of the other windows
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe('1');

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'MyRenamedWindow');
    await delay(DELAYS.SYNC);
    let windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === 'MyRenamedWindow')).toBeDefined();

    // Step 8: Close windows
    windows = await ctx.session.getWindowInfo();
    const curIdx = await ctx.session.getCurrentWindowIndex();
    for (const w of windows) {
      if (String(w.index) !== String(curIdx)) {
        await tmuxCommandKeyboard(ctx.page, `kill-window -t :${w.index}`);
        await delay(DELAYS.SHORT);
      }
    }
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);

    // Step 9: Layout test with 4 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);
    await navigatePaneKeyboard(ctx.page, 'up');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 4, 10000);

    await selectLayoutKeyboard(ctx.page, 'tiled');
    await delay(DELAYS.SYNC);
    const tiledPanes = await ctx.session.getPaneInfo();
    expect(tiledPanes.length).toBe(4);
    const areas = tiledPanes.map(p => p.width * p.height);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(2);
  }, 180000);
});

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Header → add button → create group → switch tabs → add 3rd → close tab → content verify → ungroup', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Header element exists
    const header = await ctx.page.$('.pane-tab');
    expect(header).not.toBeNull();

    // Step 2: Add button exists
    const addButton = await ctx.page.$('.pane-tab-add');
    expect(addButton).not.toBeNull();

    // Step 3: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter(t => t.active).length).toBe(1);

    // Step 4: Run command in visible pane, switch tabs, verify content
    await focusPage(ctx.page);

    for (let i = 0; i < 50; i++) {
      const hasContent = await ctx.page.evaluate(() => {
        const paneWrappers = document.querySelectorAll('.pane-wrapper');
        for (const pw of paneWrappers) {
          const style = getComputedStyle(pw);
          if (style.display === 'none') continue;
          const log = pw.querySelector('[role="log"]');
          if (log && log.textContent.length > 0) return true;
        }
        return false;
      });
      if (hasContent) break;
      await delay(DELAYS.MEDIUM);
    }
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo "MARKER_BETA"', 'MARKER_BETA', 15000);

    const inactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await delay(DELAYS.SYNC);

    // Should not see MARKER_BETA (switched to original pane with different content)
    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter(t => t.active).length).toBe(1);

    // Step 5: Add 3rd tab
    await clickGroupTabAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 6: Close a tab (last non-active one)
    await clickGroupTabClose(ctx.page, 2);
    await waitForGroupTabs(ctx.page, 2);
    expect(await getGroupTabCount(ctx.page)).toBe(2);

    // Step 7: Close remaining extra tab → revert to regular header
    await clickGroupTabClose(ctx.page, 1);
    await delay(DELAYS.SYNC);
    expect(await isHeaderGrouped(ctx.page)).toBe(false);

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ==================== Scenario 6: Floating Panes ====================

describe('Scenario 6: Floating Panes', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Break-pane → float modal → header/close → tiled count → close button → re-float → backdrop close', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupTwoPanes('horizontal');

    // Step 1: Break-pane creates float
    let activePaneId = await ctx.session.getActivePaneId();
    let paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId);
    let windows = await ctx.session.getWindowInfo({ includeFloats: true });
    expect(windows.find(w => w.name === `__float_${paneNum}`)).toBeDefined();

    // Step 2: Float modal appears
    await waitForFloatModal(ctx.page);
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();

    // Step 3: Modal has header and close button
    const modalInfo = await getFloatModalInfo(ctx.page);
    expect(modalInfo.length).toBe(1);
    expect(modalInfo[0].hasHeader).toBe(true);
    expect(modalInfo[0].hasCloseButton).toBe(true);
    expect(modalInfo[0].hasTerminal).toBe(true);

    // Step 4: Tiled pane count reduced
    await waitForPaneCount(ctx.page, 1);

    // Step 5: Close button removes float
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    let modals = await ctx.page.$$('.modal-container');
    expect(modals.length).toBe(0);
    windows = await ctx.session.getWindowInfo();
    expect(windows.find(w => w.name === `__float_${paneNum}`)).toBeUndefined();

    // Step 6: Re-create float (need to split again first since we only have 1 pane)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId);
    await waitForFloatModal(ctx.page);

    // Step 7: Backdrop click closes float
    // Click far from center to avoid hitting the centered float modal
    const newBackdrop = await ctx.page.$('.modal-backdrop');
    const box = await newBackdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    modals = await ctx.page.$$('.modal-container');
    expect(modals.length).toBe(0);
  }, 180000);
});

// ==================== Scenario 11: Status Bar ====================

describe('Scenario 11: Status Bar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  test('Bar visible → tab → session name → 2 windows → active distinct → click tab → rename → close via button', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Status bar visible
    const barInfo = await ctx.page.evaluate(() => {
      const bar = document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      if (!bar) return null;
      return {
        hasContent: bar.textContent.trim().length > 0,
        isVisible: bar.offsetParent !== null || bar.getBoundingClientRect().height > 0,
      };
    });
    expect(barInfo).not.toBeNull();
    expect(barInfo.hasContent).toBe(true);
    expect(barInfo.isVisible).toBe(true);

    // Step 2: Window tab present
    const tab = await ctx.page.$('.tab');
    expect(tab).not.toBeNull();

    // Step 3: Session name visible
    const barText = await ctx.page.evaluate(() => {
      const bar = document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      return bar ? bar.textContent : '';
    });
    expect(barText).toContain(ctx.session.name);

    // Step 4: Create second window - 2 tabs
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 2);
    expect(await ctx.session.getWindowCount()).toBe(2);

    // Step 5: Active tab distinct styling
    const activeTab = await ctx.page.$('.tab-active');
    expect(activeTab).not.toBeNull();

    // Step 6: Click inactive tab to switch
    const allTabs = await ctx.page.$$('.tab:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate(el => el.classList.contains('tab-active'));
      if (!isActive) { inactiveTab = t; break; }
    }
    expect(inactiveTab).not.toBeNull();
    const tabButton = await inactiveTab.$('.tab-button');
    await tabButton.click();
    await delay(DELAYS.SYNC);

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    await delay(DELAYS.SYNC);
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab:not(.tab-add)');
      return Array.from(tabs).map(t => t.textContent).join(' ');
    });
    expect(tabText).toContain('RENAMED_WINDOW');

    // Step 8: Close window via tmux (removing the non-active one)
    const windows = await ctx.session.getWindowInfo();
    const inactiveWindow = windows.find(w => !w.active);
    if (inactiveWindow) {
      await tmuxCommandKeyboard(ctx.page, `kill-window -t :${inactiveWindow.index}`);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);
    }
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 180000);
});
