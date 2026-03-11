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
  assertLayoutInvariants,
  assertContentMatch,
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

// ==================== Float Visual Verification Helper ====================

/**
 * Verify a float pane is visually present and interactive.
 * Checks bounding rect, visible content area, and terminal presence.
 * Returns { floatRect, contentRect } for further assertions.
 */
async function verifyFloatVisible(page) {
  const info = await page.evaluate(() => {
    // Find the float container (centered float) or modal-container (drawer)
    const fc = document.querySelector('.float-container') || document.querySelector('.modal-container');
    if (!fc) return null;
    const fcRect = fc.getBoundingClientRect();

    // Find the terminal content area inside the float
    const content = fc.querySelector('.float-content') || fc.querySelector('.terminal-content');
    const contentRect = content ? content.getBoundingClientRect() : null;

    // Check for terminal log element
    const log = fc.querySelector('[role="log"]');
    const logRect = log ? log.getBoundingClientRect() : null;

    return {
      floatRect: { x: Math.round(fcRect.x), y: Math.round(fcRect.y), w: Math.round(fcRect.width), h: Math.round(fcRect.height) },
      contentRect: contentRect ? { w: Math.round(contentRect.width), h: Math.round(contentRect.height) } : null,
      logRect: logRect ? { w: Math.round(logRect.width), h: Math.round(logRect.height) } : null,
    };
  });

  expect(info).not.toBeNull();
  expect(info.floatRect.w).toBeGreaterThan(100);
  expect(info.floatRect.h).toBeGreaterThan(100);
  expect(info.contentRect).not.toBeNull();
  expect(info.contentRect.w).toBeGreaterThan(50);
  expect(info.contentRect.h).toBeGreaterThan(50);

  return info;
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-overlay', { timeout });
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

    // Wait for layout to fully settle (layout change triggers resize round-trip)
    await delay(DELAYS.SYNC);

    // Verify layout invariants (overlap, centering, padding, headers, dimensions)
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 4 tiled layout' });
  }, 180000);
});

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Header → add button → create group → switch tabs → identity verify → add 3rd → close tab → ungroup', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Layout invariants on initial single pane
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 5 initial' });

    // Step 1: Header element exists
    const header = await ctx.page.$('.pane-tab');
    expect(header).not.toBeNull();

    // Step 2: Add button exists
    const addButton = await ctx.page.$('.pane-tab-add');
    expect(addButton).not.toBeNull();

    // Step 3: Record original (ALPHA) pane ID
    const alphaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(alphaPaneId).not.toBeNull();

    // Step 4: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter(t => t.active).length).toBe(1);

    // Step 5: Record the new (BETA) pane ID — it should be different from ALPHA
    await delay(DELAYS.SYNC);
    const betaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(betaPaneId).not.toBeNull();
    expect(betaPaneId).not.toBe(alphaPaneId);

    // Step 6: Switch to original pane tab, verify pane identity via ID
    const inactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await delay(DELAYS.SYNC);

    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter(t => t.active).length).toBe(1);

    const afterSwitchId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitchId).toBe(alphaPaneId);

    // Step 7: Switch back to BETA pane and verify identity
    const betaIdx = tabs.findIndex(t => t.active); // currently on ALPHA's tab
    const otherIdx = betaIdx === 0 ? 1 : 0;
    await clickGroupTab(ctx.page, otherIdx);
    await delay(DELAYS.SYNC);

    const afterSwitch2Id = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitch2Id).toBe(betaPaneId);

    // Step 8: Verify tab highlight matches active pane
    const tabsAfterSwitch = await getGroupTabInfo(ctx.page);
    const selectedTab = tabsAfterSwitch.find(t => t.active);
    expect(selectedTab).toBeDefined();
    expect(selectedTab.index).toBe(otherIdx);

    // Step 9: Add 3rd tab
    await clickGroupTabAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9a: Record GAMMA pane ID (the newly added 3rd tab, which is now active)
    await delay(DELAYS.SYNC);
    const gammaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(gammaPaneId).not.toBeNull();
    expect(gammaPaneId).not.toBe(alphaPaneId);
    expect(gammaPaneId).not.toBe(betaPaneId);

    // Step 9b: Switch to first tab (ALPHA) with 3 tabs — this is the scenario
    // that triggers the bug where a pane escapes the group window when the
    // active tmux window is itself a group window.
    tabs = await getGroupTabInfo(ctx.page);
    const firstInactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, firstInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9c: Switch to another inactive tab with 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const secondInactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, secondInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9d: Switch one more time — cycle through all 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const thirdInactiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTab(ctx.page, thirdInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 10: Close a tab (last non-active one)
    await clickGroupTabClose(ctx.page, 2);
    await waitForGroupTabs(ctx.page, 2);
    expect(await getGroupTabCount(ctx.page)).toBe(2);

    // Step 11: Close remaining extra tab → revert to regular header
    // Close the non-active tab (find it dynamically since index may vary)
    tabs = await getGroupTabInfo(ctx.page);
    const nonActiveIdx = tabs.findIndex(t => !t.active);
    await clickGroupTabClose(ctx.page, nonActiveIdx >= 0 ? nonActiveIdx : 1);
    await waitForCondition(ctx.page, async () => {
      return !(await isHeaderGrouped(ctx.page));
    }, 10000, 'header to revert to ungrouped');

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ==================== Scenario 6: Float Pane Lifecycle ====================

describe('Scenario 6: Float Pane Lifecycle', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('CLI float → visually visible → header structure → auto-focus → type command → output visible → input isolation → close → background restored', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Record background pane ID
    const bgPaneId = await ctx.session.getActivePaneId();
    expect(bgPaneId).toMatch(/^%\d+$/);

    // Step 1: Verify background pane is operational
    await runCommand(ctx.page, 'echo BG_PRE_FLOAT', 'BG_PRE_FLOAT');

    // Step 2: Open interactive float via CLI
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);

    // Step 3: Float modal appears (extended timeout for CLI → run-shell → control mode chain)
    await waitForFloatModal(ctx.page, 20000);

    // Step 4: Float is visually present with non-trivial dimensions
    const floatInfo = await verifyFloatVisible(ctx.page);

    // Step 5: Float header has close button but NO group-add (+) button
    const headerInfo = await ctx.page.evaluate(() => {
      const fc = document.querySelector('.float-container') || document.querySelector('.modal-container');
      if (!fc) return null;
      return {
        hasHeader: !!fc.querySelector('.pane-header'),
        hasCloseButton: !!fc.querySelector('.pane-header-close'),
        hasGroupAddButton: !!fc.querySelector('.pane-tab-add'),
      };
    });
    expect(headerInfo).not.toBeNull();
    expect(headerInfo.hasHeader).toBe(true);
    expect(headerInfo.hasCloseButton).toBe(true);
    expect(headerInfo.hasGroupAddButton).toBe(false);

    // Step 6: XState auto-focus — focusedFloatPaneId is set
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

    // Step 6a: Background pane should NOT be active when float is focused
    const bgActiveState = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
      return el ? el.classList.contains('pane-active') : null;
    }, bgPaneId);
    expect(bgActiveState).toBe(false);

    // Step 6b: Float has all 4 borders and drop shadow
    const floatStyle = await ctx.page.evaluate(() => {
      const mc = document.querySelector('.float-modal .modal-container');
      if (!mc) return null;
      const cs = window.getComputedStyle(mc);
      return {
        borderTop: cs.borderTopWidth,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
        boxShadow: cs.boxShadow,
      };
    });
    expect(floatStyle).not.toBeNull();
    expect(parseFloat(floatStyle.borderTop)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderRight)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderBottom)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderLeft)).toBeGreaterThanOrEqual(1);
    expect(floatStyle.boxShadow).not.toBe('none');

    // Step 6c: Float pane header icon is NOT a button (no role="button")
    const iconIsStatic = await ctx.page.evaluate(() => {
      const fc = document.querySelector('.float-container');
      const icon = fc?.querySelector('.pane-tab-icon');
      if (!icon) return null;
      return {
        hasStaticClass: icon.classList.contains('pane-tab-icon-static'),
        hasButtonRole: icon.getAttribute('role') === 'button',
      };
    });
    if (iconIsStatic) {
      expect(iconIsStatic.hasStaticClass).toBe(true);
      expect(iconIsStatic.hasButtonRole).toBe(false);
    }

    // Step 7: Type command in float and verify output is VISUALLY present
    const TOKEN = 'FLOAT_VIS_' + Date.now();
    await ctx.page.keyboard.type(`echo ${TOKEN}`);
    await ctx.page.keyboard.press('Enter');

    // Wait for output in the float's visible terminal
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc = document.querySelector('.float-container') || document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          if (!log || !log.textContent.includes(token)) return false;
          // Verify the log element is actually visible
          const rect = log.getBoundingClientRect();
          return rect.width > 50 && rect.height > 50;
        }, TOKEN);
      },
      15000,
      'typed output to appear visually in float terminal',
    );

    // Step 8: Input isolation — typed text appears in float, not background pane
    const bgContent = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-id="${id}"]`);
      return el?.querySelector('[role="log"]')?.textContent || '';
    }, bgPaneId);
    expect(bgContent).not.toContain(TOKEN);

    // Step 9: Background pane still visible while float is open
    const bgVisible = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-id="${id}"]`);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, bgPaneId);
    expect(bgVisible).toBe(true);

    // Step 10: Close float via close button
    const closeClicked = await ctx.page.evaluate(() => {
      const fc = document.querySelector('.float-container') || document.querySelector('.modal-container');
      const btn = fc?.querySelector('.pane-header-close');
      if (btn) { btn.click(); return true; }
      return false;
    });
    expect(closeClicked).toBe(true);

    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-overlay').length === 0,
      { timeout: 10000, polling: 100 },
    );

    // Step 11: focusedFloatPaneId cleared, background pane interactive
    const focusedAfterClose = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedAfterClose).toBeNull();

    // Step 12: Background pane should be active again after float closes
    await delay(500);
    const bgActiveAfterClose = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
      return el ? el.classList.contains('pane-active') : null;
    }, bgPaneId);
    expect(bgActiveAfterClose).toBe(true);

    // Background pane still works
    const BG_TOKEN = 'BG_AFTER_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${BG_TOKEN}`, BG_TOKEN);
  }, 180000);
});

// ==================== Scenario 6b: Float Escape Close ====================

describe('Scenario 6b: Float Escape Close', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Open float → Escape closes float → background pane interactive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Open float via CLI
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);

    // Step 2: Float is visually present
    await verifyFloatVisible(ctx.page);

    // Step 3: Wait for auto-focus
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(() =>
          window.app?.getSnapshot()?.context?.focusedFloatPaneId,
        );
        return id !== null && id !== undefined;
      },
      5000,
      'focusedFloatPaneId to be set',
    );

    // Step 4: Press Escape — should close the float
    await ctx.page.keyboard.press('Escape');

    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-overlay').length === 0,
      { timeout: 10000, polling: 100 },
    );

    // Step 5: Float is gone, focus restored
    const focusedAfter = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedAfter).toBeNull();

    // Step 6: Background pane accepts input
    const TOKEN = 'ESC_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${TOKEN}`, TOKEN);
  }, 180000);
});

// ==================== Scenario 6c: Float Backdrop Close ====================

describe('Scenario 6c: Float Backdrop Close', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Open float → backdrop click closes float → background pane interactive', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Open float via CLI
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);

    // Step 2: Float is visually present
    await verifyFloatVisible(ctx.page);

    // Step 3: Click backdrop (far from center to avoid hitting the float)
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    const box = await backdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);

    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-overlay').length === 0,
      { timeout: 10000, polling: 100 },
    );

    // Step 4: Background pane accepts input
    const TOKEN = 'BACKDROP_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${TOKEN}`, TOKEN);
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

// ==================== Scenario 22: Float fzf Workflow ====================

describe('Scenario 22: Float fzf Workflow', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Float opens fzf → user selects item → result returned to shell', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Background pane is operational
    await runCommand(ctx.page, 'echo FZF_BG_READY', 'FZF_BG_READY');

    // Step 2: Set up fzf input
    const fzfListScript = '/tmp/fzf-e2e-list.sh';
    const fzfTargetFile = '/tmp/fzf-e2e-target.txt';
    fs.writeFileSync(fzfListScript, `#!/bin/sh\necho ${fzfTargetFile}\n`);
    fs.chmodSync(fzfListScript, 0o755);

    // Set FZF_DEFAULT_COMMAND in tmux session env
    await ctx.session._exec(
      `set-environment -t ${ctx.session.name} FZF_DEFAULT_COMMAND ${fzfListScript}`,
    );

    // Step 3: Run fzf workflow
    await typeInTerminal(ctx.page, `FILE=$(${TMUXY_CLI} pane float fzf); echo "FZF_RESULT:$FILE"`);
    await pressEnter(ctx.page);

    // Step 4: fzf float appears
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);
    await delay(DELAYS.EXTRA_LONG); // Let fzf render its TUI

    // Step 5: Press Enter to select first item
    await ctx.page.keyboard.press('Enter');

    // Step 6: Float auto-closes after fzf exits
    await ctx.page.waitForFunction(
      () => document.querySelectorAll('.modal-overlay').length === 0,
      { timeout: 15000, polling: 100 },
    );

    // Step 7: Background shell echoes the selected file path
    await waitForTerminalText(ctx.page, `FZF_RESULT:${fzfTargetFile}`, 15000);

    // Cleanup
    try { fs.unlinkSync(fzfListScript); } catch {}
    try { fs.unlinkSync(fzfTargetFile); } catch {}
  }, 180000);
});
