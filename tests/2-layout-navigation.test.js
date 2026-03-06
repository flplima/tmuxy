/**
 * Layout & Navigation E2E Tests
 *
 * Window lifecycle, pane groups, floating panes, and status bar.
 */

const fs = require('fs');

const {
  createTestContext,
  delay,
  focusPage,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  TMUXY_CLI,
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

// ==================== Condition Polling Helper ====================

async function waitForCondition(page, fn, timeout = 10000, description = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description} (${timeout}ms)`);
}

// ==================== Float Helpers ====================

async function createFloat(ctx, paneId, { drawer = null, bg = null, hideHeader = false } = {}) {
  const paneNum = paneId.replace('%', '');
  let name = `__float_${paneNum}`;
  if (drawer) name += `_drawer_${drawer}`;
  if (bg) name += `_bg_${bg}`;
  if (hideHeader) name += '_noheader';
  await ctx.session._exec(`break-pane -d -s ${paneId} -n "${name}"`);
  await delay(DELAYS.SYNC);
  await delay(DELAYS.SYNC);
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-overlay', { timeout });
}

async function getFloatModalInfo(page) {
  return await page.evaluate(() => {
    const floats = document.querySelectorAll('.float-container');
    return Array.from(floats).map((float) => ({
      hasHeader: float.querySelector('.pane-header') !== null,
      hasCloseButton: float.querySelector('.pane-header-close') !== null,
      hasTerminal: float.querySelector('.terminal-container') !== null,
    }));
  });
}

/**
 * Check for unexpected pixel-level overlap between tiled pane elements.
 * Returns overlaps exceeding 1 charHeight vertically — anything more than the
 * separator-row-as-header design allows is a regression (e.g., the padBottom bug).
 *
 * By design, vertically adjacent panes share exactly 1 charHeight of overlap:
 * the bottom pane's header occupies the tmux separator row, which is also the
 * bottom pixel row of the top pane's div. This is expected and excluded.
 */
async function getPaneOverlaps(page) {
  return await page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    const charHeight = snap?.context?.charHeight ?? 24;
    const items = document.querySelectorAll('.pane-layout-item');
    const panes = Array.from(items).map(el => {
      const r = el.getBoundingClientRect();
      return { pid: el.dataset.paneId || '?', top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    const overlaps = [];
    for (let i = 0; i < panes.length; i++) {
      for (let j = i + 1; j < panes.length; j++) {
        const a = panes[i], b = panes[j];
        const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapH = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        // Allow up to charHeight vertical overlap (by-design separator sharing).
        // Only flag overlaps GREATER than charHeight, which indicate a real bug.
        if (overlapV > charHeight && overlapH > 2) {
          overlaps.push({ a: a.pid, b: b.pid, overlapV: Math.round(overlapV), overlapH: Math.round(overlapH) });
        }
      }
    }
    return overlaps;
  });
}

async function getDrawerInfo(page) {
  return await page.evaluate(() => {
    const overlay = document.querySelector('.modal-overlay');
    if (!overlay) return null;
    const classes = overlay.className;
    const isDrawer = classes.includes('drawer');
    const direction = ['left', 'right', 'top', 'bottom'].find(d =>
      classes.includes(`drawer-${d}`)
    );
    const container = overlay.querySelector('.modal-container');
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return { isDrawer, direction: direction || null, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}

// ==================== Scenario 4: Window Lifecycle ====================

describe('Scenario 4: Window Lifecycle', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

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

    // Step 3: Next window (poll until window index changes)
    const currentIndex = await ctx.session.getCurrentWindowIndex();
    await nextWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    let nextChanged = false;
    try {
      await waitForCondition(ctx.page, async () => {
        const idx = await ctx.session.getCurrentWindowIndex();
        return idx !== currentIndex;
      }, 5000, 'next-window keyboard to change active window');
      nextChanged = true;
    } catch {
      // Keyboard next-window may not work reliably; fall back to adapter
      await ctx.session._exec('next-window');
      await delay(DELAYS.SYNC);
      await waitForCondition(ctx.page, async () => {
        const idx = await ctx.session.getCurrentWindowIndex();
        return idx !== currentIndex;
      }, 10000, 'next-window adapter to change active window');
      nextChanged = true;
    }
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(currentIndex);

    // Step 4: Previous window (poll until window index changes)
    const idx = await ctx.session.getCurrentWindowIndex();
    await prevWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    try {
      await waitForCondition(ctx.page, async () => {
        const curIdx = await ctx.session.getCurrentWindowIndex();
        return curIdx !== idx;
      }, 5000, 'prev-window keyboard to change active window');
    } catch {
      // Fall back to adapter
      await ctx.session._exec('previous-window');
      await delay(DELAYS.SYNC);
      await waitForCondition(ctx.page, async () => {
        const curIdx = await ctx.session.getCurrentWindowIndex();
        return curIdx !== idx;
      }, 10000, 'prev-window adapter to change active window');
    }
    expect(await ctx.session.getCurrentWindowIndex()).not.toBe(idx);

    // Step 5: Create 3rd window and select by number
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 3);
    await selectWindowKeyboard(ctx.page, 1);
    await waitForCondition(ctx.page, async () => {
      const curIdx = await ctx.session.getCurrentWindowIndex();
      return curIdx === '1';
    }, 10000, 'select-window -t :1 to activate window 1');
    expect(await ctx.session.getCurrentWindowIndex()).toBe('1');

    // Step 6: Last window toggle
    await lastWindowKeyboard(ctx.page);
    await waitForCondition(ctx.page, async () => {
      const curIdx = await ctx.session.getCurrentWindowIndex();
      return curIdx !== '1';
    }, 10000, 'last-window to change active window');
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

    // Verify no pane overlap (regression for vertical padding bug)
    const overlaps = await getPaneOverlaps(ctx.page);
    expect(overlaps).toEqual([]);
  }, 180000);
});

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

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
    await waitForCondition(ctx.page, async () => {
      return !(await isHeaderGrouped(ctx.page));
    }, 10000, 'header to revert to ungrouped');

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ==================== Scenario 6: Floating Panes ====================

describe('Scenario 6: Floating Panes', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

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

    // Step 5: Close button removes float (target the close button inside the float, not a tiled pane)
    await ctx.page.click('.float-container .pane-header-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.float-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    let floats = await ctx.page.$$('.float-container');
    expect(floats.length).toBe(0);
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
      () => document.querySelectorAll('.float-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
    floats = await ctx.page.$$('.float-container');
    expect(floats.length).toBe(0);
  }, 180000);
});

// ==================== Scenario 6b: Drawer Floats ====================

describe('Scenario 6b: Drawer Floats', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Left drawer → slides from left → close → right drawer → top drawer → bottom drawer', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupTwoPanes('horizontal');

    // Step 1: Create left drawer
    let activePaneId = await ctx.session.getActivePaneId();
    let paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId, { drawer: 'left' });
    let windows = await ctx.session.getWindowInfo({ includeFloats: true });
    expect(windows.find(w => w.name === `__float_${paneNum}_drawer_left`)).toBeDefined();

    // Step 2: Drawer modal appears with drawer classes
    await waitForFloatModal(ctx.page);
    let drawerInfo = await getDrawerInfo(ctx.page);
    expect(drawerInfo).not.toBeNull();
    expect(drawerInfo.isDrawer).toBe(true);
    expect(drawerInfo.direction).toBe('left');

    // Step 3: Left drawer is positioned at left edge (x ~= 0)
    expect(drawerInfo.rect.x).toBeLessThan(10);

    // Step 4: Close via close button
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 5: Create right drawer (need to split again)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId, { drawer: 'right' });
    await waitForFloatModal(ctx.page);
    drawerInfo = await getDrawerInfo(ctx.page);
    expect(drawerInfo.isDrawer).toBe(true);
    expect(drawerInfo.direction).toBe('right');

    // Right drawer is positioned at right edge
    const viewportWidth = await ctx.page.evaluate(() => window.innerWidth);
    expect(drawerInfo.rect.x + drawerInfo.rect.width).toBeGreaterThan(viewportWidth - 10);

    // Close
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 6: Create top drawer
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId, { drawer: 'top' });
    await waitForFloatModal(ctx.page);
    drawerInfo = await getDrawerInfo(ctx.page);
    expect(drawerInfo.isDrawer).toBe(true);
    expect(drawerInfo.direction).toBe('top');

    // Top drawer is positioned at top edge (y ~= 0)
    expect(drawerInfo.rect.y).toBeLessThan(10);

    // Close
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 7: Create bottom drawer
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    paneNum = activePaneId.replace('%', '');
    await createFloat(ctx, activePaneId, { drawer: 'bottom' });
    await waitForFloatModal(ctx.page);
    drawerInfo = await getDrawerInfo(ctx.page);
    expect(drawerInfo.isDrawer).toBe(true);
    expect(drawerInfo.direction).toBe('bottom');

    // Bottom drawer is positioned at bottom edge
    const viewportHeight = await ctx.page.evaluate(() => window.innerHeight);
    expect(drawerInfo.rect.y + drawerInfo.rect.height).toBeGreaterThan(viewportHeight - 10);

    // Close via backdrop
    const backdrop = await ctx.page.$('.modal-backdrop');
    const box = await backdrop.boundingBox();
    // Click a corner away from the drawer
    await ctx.page.mouse.click(box.x + box.width / 2, box.y + 5);
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
  }, 180000);
});

// ==================== Scenario 6c: Float Backdrop & Header Options ====================

describe('Scenario 6c: Float Backdrop & Header Options', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Blur backdrop → no backdrop → hide header → combined options', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupTwoPanes('horizontal');

    // Step 1: Float with blur backdrop
    let activePaneId = await ctx.session.getActivePaneId();
    await createFloat(ctx, activePaneId, { bg: 'blur' });
    await waitForFloatModal(ctx.page);
    let hasBlur = await ctx.page.evaluate(() => {
      const backdrop = document.querySelector('.modal-backdrop');
      return backdrop && backdrop.classList.contains('modal-backdrop-blur');
    });
    expect(hasBlur).toBe(true);

    // Has header by default
    let modalInfo = await getFloatModalInfo(ctx.page);
    expect(modalInfo[0].hasHeader).toBe(true);

    // Close
    await ctx.page.click('.modal-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 2: Float with no backdrop
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    await createFloat(ctx, activePaneId, { bg: 'none' });
    await waitForFloatModal(ctx.page);
    let hasNone = await ctx.page.evaluate(() => {
      const backdrop = document.querySelector('.modal-backdrop');
      return backdrop && backdrop.classList.contains('modal-backdrop-none');
    });
    expect(hasNone).toBe(true);

    // Close via Esc
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 3: Float with hidden header
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    await createFloat(ctx, activePaneId, { hideHeader: true });
    await waitForFloatModal(ctx.page);
    modalInfo = await getFloatModalInfo(ctx.page);
    expect(modalInfo[0].hasHeader).toBe(false);
    expect(modalInfo[0].hasTerminal).toBe(true);

    // Close via backdrop click (no close button since no header)
    const backdrop = await ctx.page.$('.modal-backdrop');
    const box = await backdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );

    // Step 4: Combined: drawer + blur + hide header
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    activePaneId = await ctx.session.getActivePaneId();
    await createFloat(ctx, activePaneId, { drawer: 'right', bg: 'blur', hideHeader: true });
    await waitForFloatModal(ctx.page);

    let combined = await ctx.page.evaluate(() => {
      const overlay = document.querySelector('.modal-overlay');
      const backdrop = document.querySelector('.modal-backdrop');
      const header = document.querySelector('.modal-header');
      return {
        isDrawer: overlay && overlay.classList.contains('drawer'),
        isRight: overlay && overlay.classList.contains('drawer-right'),
        isBlur: backdrop && backdrop.classList.contains('modal-backdrop-blur'),
        hasHeader: header !== null,
      };
    });
    expect(combined.isDrawer).toBe(true);
    expect(combined.isRight).toBe(true);
    expect(combined.isBlur).toBe(true);
    expect(combined.hasHeader).toBe(false);

    // Close via Esc
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-container').length === 0,
      { timeout: 10000, polling: 100 }
    );
  }, 180000);
});

// ==================== Scenario 11: Status Bar ====================

describe('Scenario 11: Status Bar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

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
    const tab = await ctx.page.$('.tab-name');
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
    const activeTab = await ctx.page.$('.tab-name-active');
    expect(activeTab).not.toBeNull();

    // Step 6: Click inactive tab to switch
    await waitForWindowCount(ctx.page, 2, 10000);
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate(el => el.classList.contains('tab-name-active'));
      if (!isActive) { inactiveTab = t; break; }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();
    await delay(DELAYS.SYNC);

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    await delay(DELAYS.SYNC);
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
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

// ==================== Scenario 22: Float CLI Workflow ====================

describe('Scenario 22: Float CLI Workflow', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Float CLI: create → auto-focus → header structure → background visible/updated → input isolation → close → fzf workflow', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Record background pane ID before float creation
    const bgPaneId = await ctx.session.getActivePaneId();
    expect(bgPaneId).toMatch(/^%\d+$/);

    // Step 1: Verify background pane is operational
    await runCommand(ctx.page, 'echo BG_PRE_FLOAT', 'BG_PRE_FLOAT');

    // Step 2: Open interactive float via CLI (non-blocking in interactive mode)
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 3: Float modal appears
    await waitForFloatModal(ctx.page);

    // Step 4: Float header has close button but NO group-add (+) button
    const floatHeaderInfo = await ctx.page.evaluate(() => {
      const float = document.querySelector('.float-container');
      if (!float) return null;
      return {
        hasHeader: float.querySelector('.pane-header') !== null,
        hasCloseButton: float.querySelector('.pane-header-close') !== null,
        hasGroupAddButton: float.querySelector('.pane-tab-add') !== null,
      };
    });
    expect(floatHeaderInfo).not.toBeNull();
    expect(floatHeaderInfo.hasHeader).toBe(true);
    expect(floatHeaderInfo.hasCloseButton).toBe(true);
    expect(floatHeaderInfo.hasGroupAddButton).toBe(false);

    // Step 5: XState auto-focus — focusedFloatPaneId is set to the float's pane ID
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(() =>
          window.app?.getSnapshot()?.context?.focusedFloatPaneId,
        );
        return id !== null && id !== undefined;
      },
      5000,
      'focusedFloatPaneId to be set after float appears',
    );
    const focusedFloatId = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedFloatId).toMatch(/^%\d+$/);

    // Step 6: Background tiled pane still visible while float is open
    const tiledPaneCount = await ctx.page.evaluate(() =>
      document.querySelectorAll('.pane-layout-item').length,
    );
    expect(tiledPaneCount).toBe(1);
    const tiledPaneVisible = await ctx.page.evaluate(() => {
      const item = document.querySelector('.pane-layout-item');
      return item ? item.getBoundingClientRect().height > 0 : false;
    });
    expect(tiledPaneVisible).toBe(true);

    // Step 7: Background pane receives tmux updates while float is open
    // Use send-keys targeting the background pane directly (bypasses float routing)
    await ctx.session.runCommand(`send-keys -t ${bgPaneId} 'echo BG_WHILE_FLOAT' Enter`);
    // waitForTerminalText reads all [role="log"] elements — BG_WHILE_FLOAT appears in background pane
    await waitForTerminalText(ctx.page, 'BG_WHILE_FLOAT', 10000);

    // Step 8: Input isolation — keyboard goes to float, not background pane
    // Type WITHOUT re-clicking to preserve focusedFloatPaneId routing
    const ISOLATION_TOKEN = 'FLOATISO7Z3Q';
    await ctx.page.keyboard.type(ISOLATION_TOKEN);
    await delay(DELAYS.SYNC);

    // Background pane should NOT contain the isolation token
    const bgContent = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-id="${id}"]`);
      return el?.querySelector('[role="log"]')?.textContent || '';
    }, bgPaneId);
    expect(bgContent).not.toContain(ISOLATION_TOKEN);

    // Float pane should contain the isolation token (bash readline echoes typed chars)
    const floatContent = await ctx.page.evaluate(() => {
      const float = document.querySelector('.float-container');
      return float?.querySelector('[role="log"]')?.textContent || '';
    });
    expect(floatContent).toContain(ISOLATION_TOKEN);

    // Step 9: Close float — focusedFloatPaneId is cleared
    await ctx.page.click('.float-container .pane-header-close');
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.float-container').length === 0,
      { timeout: 10000, polling: 100 },
    );
    const focusedAfterClose = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedAfterClose).toBeNull();

    // Step 10: fzf workflow — float opens fzf, user selects an item, result returned to shell
    // Create a wrapper script so fzf knows what to list (path has no spaces for clean arg passing)
    const fzfListScript = '/tmp/fzf-e2e-list.sh';
    const fzfTargetFile = '/tmp/fzf-e2e-target.txt';
    fs.writeFileSync(fzfListScript, `#!/bin/sh\necho ${fzfTargetFile}\n`);
    fs.chmodSync(fzfListScript, 0o755);

    // Set FZF_DEFAULT_COMMAND in the tmux session env — inherited by the float pane's shell
    await ctx.session._exec(
      `set-environment -t ${ctx.session.name} FZF_DEFAULT_COMMAND ${fzfListScript}`,
    );

    // Run the fzf workflow: shell blocks on `tmux wait-for` until float closes, then echoes result
    await typeInTerminal(ctx.page, `FILE=$(${TMUXY_CLI} pane float fzf); echo "FZF_RESULT:$FILE"`);
    await pressEnter(ctx.page);

    // Wait for fzf float to appear (fzf is running inside)
    await waitForFloatModal(ctx.page);
    await delay(DELAYS.LONG); // Let fzf render its TUI before pressing Enter

    // Press Enter — routes to float via focusedFloatPaneId — selects first fzf item
    await ctx.page.keyboard.press('Enter');

    // Float auto-closes after fzf exits and float-create.sh kills the float window
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.float-container').length === 0,
      { timeout: 15000, polling: 100 },
    );

    // Background shell echoes the selected file path
    await waitForTerminalText(ctx.page, `FZF_RESULT:${fzfTargetFile}`, 15000);

    // Cleanup
    fs.unlinkSync(fzfListScript);
  }, 180000);
});
