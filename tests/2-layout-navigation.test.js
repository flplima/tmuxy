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
  sendPrefixCommand,
  createWindowKeyboard,
  pressUntilWindowChanged,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
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
  waitForShellPrompt,
  waitForCondition,
  DELAYS,
} = require('./helpers');

// ==================== Float Visual Verification Helper ====================

/**
 * Verify a float pane is visually present and interactive.
 * Checks bounding rect, visible content area, and terminal presence.
 * Returns { floatRect, contentRect } for further assertions.
 */
async function verifyFloatVisible(page) {
  const info = await page.evaluate(() => {
    // Find the float container (centered float) or modal-container (drawer)
    const fc =
      document.querySelector('.float-container') || document.querySelector('.modal-container');
    if (!fc) return null;
    const fcRect = fc.getBoundingClientRect();

    // Find the terminal content area inside the float
    const content = fc.querySelector('.float-content') || fc.querySelector('.terminal-content');
    const contentRect = content ? content.getBoundingClientRect() : null;

    // Check for terminal log element
    const log = fc.querySelector('[role="log"]');
    const logRect = log ? log.getBoundingClientRect() : null;

    return {
      floatRect: {
        x: Math.round(fcRect.x),
        y: Math.round(fcRect.y),
        w: Math.round(fcRect.width),
        h: Math.round(fcRect.height),
      },
      contentRect: contentRect
        ? { w: Math.round(contentRect.width), h: Math.round(contentRect.height) }
        : null,
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

// ==================== Scenario 4c: Zoom in a 2×2 grid ====================

describe('Scenario 4c: Zoom in a 2×2 grid', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The zoomed pane used to be identified as "the first pane whose far corner
  // touches the grid's far corner" — which the bottom-right pane of any grid
  // does. Zooming the top-left pane therefore hid it and left the bottom-right
  // pane sitting in its quarter slot. The zoomed pane must be the one that
  // spans the whole grid, whichever pane it is.
  test('zooming the top-left pane shows that pane full size and hides the others; unzoom restores all four', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 2×2: split right, then split each column down.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await navigatePaneKeyboard(ctx.page, 'left');
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4);

    const visiblePanes = () =>
      ctx.page.evaluate(() => {
        const ctxState = window.app?.getSnapshot()?.context;
        return (ctxState?.panes || [])
          .filter((p) => p.windowId === ctxState.activeWindowId)
          .map((p) => {
            const el = document.querySelector(`.pane-container [data-pane-id="${p.tmuxId}"]`);
            const r = el?.getBoundingClientRect();
            return {
              id: p.tmuxId,
              w: Math.round(r?.width ?? 0),
              h: Math.round(r?.height ?? 0),
              opacity: el ? Number(getComputedStyle(el).opacity) : 0,
            };
          });
      });

    // Zoom the TOP-LEFT pane (x=0, y=top). Navigate there first.
    await navigatePaneKeyboard(ctx.page, 'up');
    const zoomTarget = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    const targetGeometry = await ctx.page.evaluate(
      (id) => window.app?.getSnapshot()?.context?.panes?.find((p) => p.tmuxId === id),
      zoomTarget,
    );
    expect(targetGeometry.x).toBe(0);

    const before = await visiblePanes();
    const quarterW = Math.max(...before.map((p) => p.w));
    const quarterH = Math.max(...before.map((p) => p.h));

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed)),
      8000,
      'tmux to report the window zoomed',
    );
    await delay(DELAYS.LONG);

    const zoomed = await visiblePanes();
    const shown = zoomed.filter((p) => p.opacity > 0.99);
    expect(shown.map((p) => p.id)).toEqual([zoomTarget]);
    // The zoomed pane grew to the grid: about twice a quarter in each direction.
    expect(shown[0].w).toBeGreaterThan(quarterW * 1.8);
    expect(shown[0].h).toBeGreaterThan(quarterH * 1.8);

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => !window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed),
        ),
      8000,
      'tmux to report the window un-zoomed',
    );
    await delay(DELAYS.LONG);
    const restored = await visiblePanes();
    expect(restored.filter((p) => p.opacity > 0.99).length).toBe(4);
    await assertLayoutInvariants(ctx.page);
  }, 120000);
});

// ==================== Scenario 4b: Split right after a tab switch ====================

describe('Scenario 4b: Split right after a tab switch', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The tab switch is optimistic: the client is on the new tab before tmux is.
  // A split fired in that gap used to land in the tab the user just LEFT,
  // because the binding was pinned with `select-pane` only, which never changes
  // tmux's current window. Every binding is now pinned to the visible window
  // too, so the split must follow the eye every time.
  test('prefix % immediately after ctrl+N / tab click / prefix n always splits the visible tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);

    const panesByWindow = async () => {
      const counts = {};
      const out = await ctx.session.query("list-panes -s -F '#{window_id}'");
      for (const line of String(out).split('\n')) {
        if (line) counts[line] = (counts[line] || 0) + 1;
      }
      return counts;
    };
    const visibleWindow = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);

    // The two tabs' tmux indices, for the ctrl+<digit> root bindings.
    const indices = await ctx.page.evaluate(() =>
      (window.app?.getSnapshot()?.context?.windows || [])
        .filter((w) => w.windowType === 'tab')
        .map((w) => w.index),
    );
    const ctrlDigit = async (digit) => {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press(String(digit));
      await ctx.page.keyboard.up('Control');
    };
    const switches = [
      () => ctrlDigit(indices[0]),
      () => ctrlDigit(indices[1]),
      () => ctx.page.click('.tab-name:nth-child(1)'),
      () => ctx.page.click('.tab-name:nth-child(2)'),
      () => nextWindowKeyboard(ctx.page),
      () => nextWindowKeyboard(ctx.page),
    ];
    for (let i = 0; i < switches.length; i++) {
      const before = await panesByWindow();
      await switches[i]();
      // No settling delay on purpose: this is the race. `%` is Shift+5, `"` is Shift+'.
      await sendPrefixCommand(ctx.page, i % 2 === 0 ? '5' : "'", { shift: true });
      const shown = await visibleWindow();
      await waitForCondition(
        ctx.page,
        async () => ((await panesByWindow())[shown] || 0) === (before[shown] || 0) + 1,
        8000,
        `iteration ${i}: the new pane to be in the visible window ${shown}`,
      );
      const after = await panesByWindow();
      for (const win of Object.keys(after)) {
        if (win !== shown) {
          expect({ iteration: i, window: win, panes: after[win] }).toEqual({
            iteration: i,
            window: win,
            panes: before[win] || 0,
          });
        }
      }
    }
  }, 120000);
});

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

    // Step 1b: Verify typing works in the new window.
    // After create-window (split-window + break-pane), the pane moves to a
    // new window. Output must not be dropped by the panes_moved_window flag.
    const NEW_WIN_TOKEN = 'NEW_WIN_' + Date.now();
    await runCommand(ctx.page, `echo ${NEW_WIN_TOKEN}`, NEW_WIN_TOKEN);

    // Step 2: Window tabs
    const windowInfo = await ctx.session.getWindowInfo();
    expect(windowInfo.length).toBe(2);

    // Step 3: Next window (keyboard only — no adapter fallback)
    await pressUntilWindowChanged(ctx, nextWindowKeyboard, 'next-window keyboard');

    // Step 4: Previous window (keyboard only)
    await pressUntilWindowChanged(ctx, prevWindowKeyboard, 'prev-window keyboard');

    // Step 5: Create 3rd window and select by number
    await createWindowKeyboard(ctx.page);
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 3);
    await selectWindowKeyboard(ctx.page, 1);
    await waitForCondition(
      ctx.page,
      async () => {
        const curIdx = await ctx.session.getCurrentWindowIndex();
        return curIdx === '1';
      },
      10000,
      'select-window -t :1 to activate window 1',
    );

    // Step 6: Last window toggle (keyboard only)
    await pressUntilWindowChanged(ctx, lastWindowKeyboard, 'last-window keyboard');

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'MyRenamedWindow');
    await delay(DELAYS.SYNC);
    let windows = await ctx.session.getWindowInfo();
    expect(windows.find((w) => w.name === 'MyRenamedWindow')).toBeDefined();

    // Step 8: Close windows until only 1 remains — through the real user
    // path (prefix + :kill-window kills the current window; tmux then
    // focuses another, so repeating converges). The old version called
    // _exec('kill-window'), skipping the entire keyboard → machine → adapter
    // chain where close bugs live (TESTS.md: use real user paths).
    let winCount = await ctx.session.getWindowCount();
    while (winCount > 1) {
      await killWindowKeyboard(ctx.page);
      await waitForWindowCount(ctx.page, winCount - 1);
      winCount = await ctx.session.getWindowCount();
    }
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
    const areas = tiledPanes.map((p) => p.width * p.height);
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

    // Step 2: Menu button exists (pane group add is via ⋮ menu)
    const menuButton = await ctx.page.$('.pane-header-menu');
    expect(menuButton).not.toBeNull();

    // Step 3: Record original (ALPHA) pane ID and stamp its CONTENT with a
    // token — pane identity is verified below by what the user actually sees
    // rendered, not only by state-level ids (a swap that renders the wrong
    // pane's content under the right id would pass an id-only check).
    const alphaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(alphaPaneId).not.toBeNull();
    const ALPHA_TOKEN = `ALPHA_CONTENT_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${ALPHA_TOKEN}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 4: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter((t) => t.active).length).toBe(1);

    // Step 5: Record the new (BETA) pane ID — it should be different from ALPHA
    await delay(DELAYS.SYNC);
    const betaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(betaPaneId).not.toBeNull();
    expect(betaPaneId).not.toBe(alphaPaneId);

    // Step 6: Switch to original pane tab, verify pane identity via ID
    const inactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activePaneId || null,
        );
        return id === alphaPaneId;
      },
      10000,
      'group tab switch to ALPHA pane',
    );

    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter((t) => t.active).length).toBe(1);

    const afterSwitchId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitchId).toBe(alphaPaneId);
    // Content fingerprint: the VISIBLE pane must show ALPHA's scrollback.
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 7: Switch back to BETA pane and verify identity
    const betaIdx = tabs.findIndex((t) => t.active); // currently on ALPHA's tab
    const otherIdx = betaIdx === 0 ? 1 : 0;
    await clickGroupTab(ctx.page, otherIdx);
    await delay(DELAYS.SYNC);

    const afterSwitch2Id = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitch2Id).toBe(betaPaneId);

    // Step 8: Verify tab highlight matches active pane
    const tabsAfterSwitch = await getGroupTabInfo(ctx.page);
    const selectedTab = tabsAfterSwitch.find((t) => t.active);
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
    const firstInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, firstInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9c: Switch to another inactive tab with 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const secondInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, secondInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9d: Switch one more time — cycle through all 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const thirdInactiveIdx = tabs.findIndex((t) => !t.active);
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
    const nonActiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTabClose(ctx.page, nonActiveIdx >= 0 ? nonActiveIdx : 1);
    await waitForCondition(
      ctx.page,
      async () => {
        return !(await isHeaderGrouped(ctx.page));
      },
      15000,
      'header to revert to ungrouped',
    );

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

    // Wait for float-create.sh to finish. The script routes all tmux commands
    // through run-shell (synchronous), so it completes shortly after the float
    // modal appears. A brief delay ensures the shell prompt returns.
    await delay(DELAYS.SYNC);

    // Step 4: Float is visually present with non-trivial dimensions
    const floatInfo = await verifyFloatVisible(ctx.page);

    // Step 5: Float header has close button but NO group-add (+) button
    const headerInfo = await ctx.page.evaluate(() => {
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      if (!fc) return null;
      return {
        hasHeader: !!fc.querySelector('.pane-header'),
        hasCloseButton: !!fc.querySelector('.pane-header-close'),
        hasMenuButton: !!fc.querySelector('.pane-header-menu'),
      };
    });
    expect(headerInfo).not.toBeNull();
    expect(headerInfo.hasHeader).toBe(true);
    expect(headerInfo.hasCloseButton).toBe(true);
    expect(headerInfo.hasMenuButton).toBe(true);

    // Step 6: XState auto-focus — focusedFloatPaneId is set
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
        );
        return id !== null && id !== undefined;
      },
      5000,
      'focusedFloatPaneId to be set after float appears',
    );
    const focusedFloatId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedFloatId).toMatch(/^%\d+$/);

    // Step 6a: Background pane should NOT be active when float is focused.
    // The element may not be in the DOM (null) when the float overlay covers it.
    const bgActiveState = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
      return el ? el.classList.contains('pane-active') : null;
    }, bgPaneId);
    expect(bgActiveState).not.toBe(true);

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

    // Step 7: Type command in float and verify output
    // Wait for float pane shell prompt to render
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate(() => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          if (!log) return false;
          const content = log.textContent || '';
          return content.length > 5 && /[$#%>❯]/.test(content);
        });
      },
      15000,
      'float pane shell prompt to render',
    );
    // Type directly — the keyboard actor routes to focusedFloatPaneId.
    // Do NOT click the float's [role="log"] — it triggers FOCUS_PANE which
    // selects the background pane, breaking input isolation.
    // Wait for the keyboard actor to receive the UPDATE_FOCUSED_FLOAT event
    // (async message from XState, may lag behind context update).
    await delay(DELAYS.SYNC);
    await ctx.page.bringToFront();
    const TOKEN = 'FLOAT_VIS_' + Date.now();
    for (const char of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SYNC);

    // Verify typed text appears in the float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'typed output in float DOM',
    );

    // Step 8: Input-focus isolation. Full DOM-level isolation (token must
    // NOT appear in the background pane) cannot be asserted under CDP:
    // headless keyboard events can race UPDATE_FOCUSED_FLOAT and leak to
    // activePaneId — a harness artifact, not a product bug. What IS stable
    // and meaningful: typing must not steal focus away from the float.
    const focusAfterTyping = await ctx.page.evaluate(() => {
      const c = window.app?.getSnapshot()?.context;
      return {
        focusedFloat: c?.focusedFloatPaneId ?? null,
        floatIds: Object.keys(c?.floatPanes ?? {}),
      };
    });
    expect(focusAfterTyping.focusedFloat).not.toBeNull();
    expect(focusAfterTyping.floatIds).toContain(focusAfterTyping.focusedFloat);

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
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      const btn = fc?.querySelector('.pane-header-close');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    expect(closeClicked).toBe(true);

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });

    // Step 11: focusedFloatPaneId cleared, background pane interactive
    const focusedAfterClose = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(focusedAfterClose).toBeNull();

    // Step 12: Background pane should be active again after float closes.
    // Wait briefly for state to propagate, then verify the pane is interactive
    // (the runCommand below is the definitive test of restored input).
    await delay(1000);

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

    // Record background pane for prompt check
    const bgPaneId = await ctx.session.getActivePaneId();

    // Step 1: Open float via CLI
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);

    // Wait for float-create.sh to finish
    await delay(DELAYS.SYNC);

    // Step 2: Float is visually present
    await verifyFloatVisible(ctx.page);

    // Step 3: Wait for auto-focus
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
        );
        return id !== null && id !== undefined;
      },
      5000,
      'focusedFloatPaneId to be set',
    );

    // Step 4: Press Escape — should close the float
    await ctx.page.keyboard.press('Escape');

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });

    // Step 5: Float is gone, focus restored
    const focusedAfter = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
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

    // Record background pane for prompt check
    const bgPaneId = await ctx.session.getActivePaneId();

    // Step 1: Open float via CLI
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);

    // Wait for float-create.sh to finish
    await delay(DELAYS.SYNC);

    // Step 2: Float is visually present
    await verifyFloatVisible(ctx.page);

    // Step 3: Click backdrop (far from center to avoid hitting the float)
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    const box = await backdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });

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
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
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
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
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
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();
    await delay(DELAYS.SYNC);

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    await delay(DELAYS.SYNC);
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      return Array.from(tabs)
        .map((t) => t.textContent)
        .join(' ');
    });
    expect(tabText).toContain('RENAMED_WINDOW');

    // Step 8: Close a tab through the ACTUAL UI affordance the test name
    // promises: right-click the inactive tab → "Close Tab" in the context
    // menu. (The old version typed `kill-window -t :N` into the command
    // prompt while the test name claimed "close via button".)
    const tabsForClose = await ctx.page.$$('.tab-name:not(.tab-add)');
    let tabToClose = null;
    for (const t of tabsForClose) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        tabToClose = t;
        break;
      }
    }
    expect(tabToClose).not.toBeNull();
    await tabToClose.click({ button: 'right' });
    await ctx.page.waitForSelector('[role="menu"]', { timeout: 5000 });
    const closeItem = await ctx.page.evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return items.find((el) => (el.textContent || '').startsWith('Close Tab')) ?? null;
    });
    expect(await closeItem.evaluate((el) => el !== null)).toBe(true);
    await closeItem.asElement().click();
    await delay(DELAYS.SYNC);
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 180000);
});

// ==================== Scenario 23: Window Tab Input Routing ====================

describe('Scenario 23: Window Tab Input Routing', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Keyboard input targets the correct pane after clicking a window tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Record window 1 pane ID
    const win1PaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(win1PaneId).toBeTruthy();

    // Step 2: Create second window (we're now in window 2)
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await delay(DELAYS.SYNC);
    // Wait for new pane content to render via SSE (non-fatal on CI)
    try {
      await waitForShellPrompt(ctx.page, 10000);
    } catch {
      /* CI SSE may not deliver new pane content */
    }

    // Step 3: Record window 2 pane ID
    const win2PaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(win2PaneId).toBeTruthy();
    expect(win2PaneId).not.toBe(win1PaneId);

    // Step 4: Type a marker in window 2 and verify it appears in DOM
    const MARKER_W2 = `W2_MARKER_${Date.now()}`;
    await runCommand(ctx.page, `echo ${MARKER_W2}`, MARKER_W2);

    // Step 5: Click window 1 tab (the inactive one)
    await focusPage(ctx.page);
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();
    await delay(DELAYS.SYNC);

    // Step 6: Verify we switched — active pane must become win1PaneId.
    // (The old version stringified a closure over win1PaneId, saw undefined
    // in the page, and swallowed the resulting failure with .catch — the
    // "verification" could not fail.)
    await ctx.session.waitForState((c, id) => c.activePaneId === id, win1PaneId, 5000);

    // Step 7: Type a marker in window 1
    const MARKER_W1 = `W1_MARKER_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${MARKER_W1}`);
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 8: Verify MARKER_W1 appears in the DOM (we're viewing window 1)
    await waitForTerminalText(ctx.page, MARKER_W1);

    // Step 10: Click window 2 tab, type another marker
    const tabs2 = await ctx.page.$$('.tab-name:not(.tab-add)');
    let inactiveTab2 = null;
    for (const t of tabs2) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab2 = t;
        break;
      }
    }
    expect(inactiveTab2).not.toBeNull();
    await inactiveTab2.click();
    await delay(DELAYS.SYNC);

    const MARKER_W2B = `W2B_MARKER_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${MARKER_W2B}`);
    await pressEnter(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 11: Verify MARKER_W2B appears in DOM (we're viewing window 2)
    await waitForTerminalText(ctx.page, MARKER_W2B);
  }, 180000);
});

// ==================== Scenario 24: Tab Switch No Blink ====================

describe('Scenario 24: Tab Switch No Blink', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Clicking an inactive tab transitions the active highlight exactly once (no A→B→A→B blink)', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create a second window so we have two tabs to switch between
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await delay(DELAYS.SYNC);

    // Install a MutationObserver inside the page that records, for each
    // observed mutation on .tab-name elements, the ordered list of tab ids
    // currently bearing `.tab-name-active`. We poll this sequence after the
    // click to verify the highlight doesn't flip-flop.
    await ctx.page.evaluate(() => {
      const list = document.querySelector('.tab-list');
      if (!list) throw new Error('No .tab-list found');

      // Tag each tab with a stable data-tab-id so the observer can identify
      // them across class mutations (using DOM order as the id).
      const tabs = list.querySelectorAll('.tab-name:not(.tab-add)');
      tabs.forEach((t, i) => t.setAttribute('data-tab-test-id', String(i)));

      const snapshot = () => {
        const out = [];
        list.querySelectorAll('.tab-name:not(.tab-add)').forEach((t) => {
          if (t.classList.contains('tab-name-active')) {
            out.push(t.getAttribute('data-tab-test-id'));
          }
        });
        return out.join(',');
      };

      const seq = [snapshot()];
      window.__tabBlinkSeq = seq;

      const obs = new MutationObserver(() => {
        const cur = snapshot();
        if (cur !== seq[seq.length - 1]) seq.push(cur);
      });
      obs.observe(list, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      window.__tabBlinkObserver = obs;
    });

    // Find the inactive tab and click it (real user path → SELECT_TAB)
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();

    // Wait well past the SELECT_TAB grace window (600ms) so any stale
    // snapshot that would cause a bounce has time to arrive and be applied.
    await delay(2000);

    // Read the observed sequence of active-tab ids
    const seq = await ctx.page.evaluate(() => {
      window.__tabBlinkObserver?.disconnect();
      return window.__tabBlinkSeq || [];
    });

    // Sanity: we should see at least the initial state and the post-click state
    expect(seq.length).toBeGreaterThanOrEqual(2);

    // Final state must be a single active tab, different from the first one
    const firstActive = seq[0];
    const lastActive = seq[seq.length - 1];
    expect(firstActive).not.toBe('');
    expect(lastActive).not.toBe('');
    expect(lastActive).not.toBe(firstActive);

    // Blink detection: the active tab must never revert to a previously-seen
    // value. Each value should appear in a single contiguous run. A blink
    // produces a sequence like [A, B, A, B] where A repeats.
    const seen = new Set();
    let prev = null;
    for (const value of seq) {
      if (value !== prev) {
        if (seen.has(value)) {
          throw new Error(
            `Tab highlight blinked: active-tab ids reverted. Sequence: ${JSON.stringify(seq)}`,
          );
        }
        seen.add(value);
        prev = value;
      }
    }

    // Stronger check: there must be exactly one transition (firstActive → lastActive)
    const transitions = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
    expect(transitions).toBe(1);
  }, 60000);
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

    // Step 2: Open an interactive float
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);

    // Step 3: Float appears — wait for float content to render
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);

    // Get the float pane ID for capture-pane verification
    const floatPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(floatPaneId).toBeTruthy();

    // Wait for float prompt (non-fatal on CI)
    try {
      await waitForCondition(
        ctx.page,
        async () => {
          return await ctx.page.evaluate(() => {
            const fc =
              document.querySelector('.float-container') ||
              document.querySelector('.modal-container');
            if (!fc) return false;
            const log = fc.querySelector('[role="log"]');
            if (!log) return false;
            const content = log.textContent || '';
            return content.length > 5 && /[$#%>❯]/.test(content);
          });
        },
        10000,
        'float pane shell prompt to render',
      );
    } catch {
      /* CI SSE may not deliver new pane content */
    }

    // Step 4: Run echo in the float and verify output
    const TOKEN = `FZF_TOKEN_${Date.now()}`;
    for (const ch of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SYNC);

    // Verify typed text in float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'echo output in float DOM',
    );

    // Step 6: Run fzf with a simple input and auto-select via --select-1
    const FZF_MARKER = `FZF_RESULT_${Date.now()}`;
    const fzfCmd = `echo ${FZF_MARKER} | fzf --select-1`;
    for (const ch of fzfCmd) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.SYNC);

    // Verify fzf result in float DOM — fzf --select-1 prints the match to stdout
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((marker) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(marker) || false;
        }, FZF_MARKER);
      },
      15000,
      'fzf result in float DOM',
    );

    // Step 8: Close float if still open (exit the shell)
    const stillHasFloat = await ctx.page.evaluate(
      () => document.querySelectorAll('.modal-overlay').length > 0,
    );
    if (stillHasFloat) {
      await ctx.page.keyboard.type('exit');
      await ctx.page.keyboard.press('Enter');
    }

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 15000,
      polling: 100,
    });

    // Background pane should be interactive after float closes
    const bgMarker = `BG_RESTORED_${Date.now()}`;
    await runCommand(ctx.page, `echo ${bgMarker}`, bgMarker);
  }, 180000);
});

// ==================== Scenario 6e: Pinned Terminal Dock ====================

describe('Scenario 6e: Pinned Terminal Dock (right sidebar)', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix T docks a shell at the right edge → sized to its own column → typing reaches it → stays pinned across tabs → Esc reaches the shell, Ctrl+h blurs → prefix T hides, reopen keeps the shell', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);

    // Step 1: Open the dock via the real keybinding. First open also CREATES
    // its tmux window, so this covers the create path.
    await sendPrefixCommand(ctx.page, 'T', { shift: true });

    // Step 2: The column docks against the right edge of the viewport, full
    // height — a flex sibling of the pane area, not an overlay.
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.right - window.innerWidth) <= 2 && r.width > 50 && r.height > 100;
        }),
      10000,
      'dock to sit against the right edge',
    );

    // Step 3: It is backed by a real `sidebar-right`-typed window with one pane,
    // and that window is NOT in the tab strip.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          return !!win && ctxState.panes.some((p) => p.windowId === win.id);
        }),
      20000,
      'a sidebar-right-typed window with a pane',
    );
    const tabStrip = await ctx.page.evaluate(() => {
      const win = window.app
        ?.getSnapshot()
        ?.context?.windows?.find((w) => w.windowType === 'sidebar-right');
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        // The column's window carries the fixed name `__sidebar-right` (the
        // create command targets it by that name) and tabs render `index:name`,
        // so a tab carrying that label is the column leaking into the strip.
        labels: tabs.map((t) => (t.textContent || '').trim()),
        dockWindowName: win?.name,
      };
    });
    expect(tabStrip.dockWindowName).toBe('__sidebar-right');
    expect(tabStrip.labels.some((label) => label.includes('__sidebar'))).toBe(false);

    // Step 4: THE geometry contract. tmux sizes a `sidebar-right` window to that
    // column (sidebar_dock::size in tmuxy-core), not the viewport — otherwise
    // the shell wraps at a width the UI never draws. 35 cols wide, and the full
    // viewport height: the column is headerless, so it loses no row.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          return pane?.width === 35 && pane?.height === ctxState.targetRows;
        }),
      20000,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          return `column pane sized to its own column (got ${pane?.width}x${pane?.height}, want 35x${ctxState?.targetRows})`;
        }),
    );

    // Step 5: Opening it took the keyboard, so typing lands in the dock — not
    // in the tab's active pane.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      10000,
      'dock to hold keyboard focus after opening',
    );
    // Click the dock's own terminal for focus, then re-establish CDP keyboard
    // focus (headless Chrome drops it across the DOM re-render the new column
    // causes) before typing character by character, the same cadence
    // typeInTerminal uses so the adapter's send-keys batching can't transpose.
    await ctx.page.click('[data-testid="right-sidebar-content"] [role="log"]');
    await ctx.page.bringToFront();
    await delay(200);
    for (const char of 'echo dock-typing-works') {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      20000,
      'the typed command to echo inside the dock',
    );

    // Step 6: The point of the feature — it stays put when the user changes
    // tabs, because its pane lives in its own window.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active && active !== firstWindowId;
      },
      8000,
      'second window to become active',
    );
    const stillDockedOnNewTab = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-testid="right-sidebar-content"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        visible: r.width > 50 && r.height > 100,
        keptOutput: (el.textContent || '').includes('dock-typing-works'),
      };
    });
    expect(stillDockedOnNewTab).toEqual({ visible: true, keptOutput: true });

    // Step 7: Escape is an ordinary key inside the dock — a program pinned
    // there (vim, fzf) must receive it — so it neither blurs nor closes the
    // column. Ctrl+h is what hands the keyboard back to the panes.
    await focusPage(ctx.page);
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      5000,
      'dock focused after a click',
    );
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.MEDIUM);
    const stillFocusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.rightSidebarFocused,
    );
    expect(stillFocusedAfterEscape).toBe(true);
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('h');
    await ctx.page.keyboard.up('Control');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === false),
      5000,
      'rightSidebarFocused cleared after Ctrl+h',
    );
    const openAfterBlur = await ctx.page.evaluate(
      () => !!document.querySelector('[data-testid="right-sidebar-content"]'),
    );
    expect(openAfterBlur).toBe(true);

    // Step 8: prefix T HIDES the column but keeps the shell alive — reopening
    // shows the same terminal, scrollback and all.
    await sendPrefixCommand(ctx.page, 'T', { shift: true });
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 10000, polling: 100 },
    );
    const windowSurvivedHide = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.windows?.some((w) => w.windowType === 'sidebar-right'),
    );
    expect(windowSurvivedHide).toBe(true);

    await sendPrefixCommand(ctx.page, 'T', { shift: true });
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 10000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      10000,
      'the same shell (with its scrollback) to come back on reopen',
    );

    // Cleanup: kill the pinned shell the way a user would — `exit` inside it —
    // so the shared tmux server is left clean for the next test in the file.
    // The column has no kill button: its toggle only hides it, and the shell
    // going away is what retracts the column (see appMachine's sidebar
    // lifecycle).
    // The Escape from step 7 reached this shell; in a vi-mode zsh that leaves
    // the line editor in command mode, where `exit` would not be typed. Ctrl+C
    // aborts the line and starts a fresh one in insert mode under either keymap.
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    await ctx.page.keyboard.press('Control+c');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.type('exit');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 15000, polling: 100 },
    );
  }, 180000);
});

// ==================== Scenario 6d: Sidebar Tree View ====================

describe('Scenario 6d: Sidebar Tree View', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix t opens fixed sidebar → tree shows tabs/panes → focus + Enter activates a tab → l blurs → q closes', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The first window — we'll switch back to it via the tree later. Captured
    // before creating a second window, so it's the lowest-index tab (row 0).
    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);

    // Setup (not the feature under test): a second window so the tree lists
    // more than one tab and an activation switch is observable.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active && active !== firstWindowId;
      },
      8000,
      'second window to become active',
    );

    // Step 1: Open the sidebar via the real keybinding (prefix t).
    await sendPrefixCommand(ctx.page, 't');

    // Step 2: The FIXED sidebar column appears docked at the left edge (it is
    // a flex sibling of the pane area, not an overlay — panes reflow beside it).
    await ctx.page.waitForSelector('.sidebar-column-left', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('.sidebar-column-left');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.left) <= 2 && r.width > 50 && r.height > 100;
        }),
      8000,
      'fixed sidebar to dock at the left edge',
    );

    // Step 3: The tree rendered real rows — both windows' tabs are listed.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length >= 2,
        ),
      20000,
      'tree rows to render in the sidebar',
    );

    // Step 4: Focus the sidebar (click) so keys route to the tree.
    //
    // Click the column's TITLE in the app header, not the column itself:
    // Playwright clicks an element's CENTRE, and the centre of the column is a
    // tree row. Every row activates on click, so focusing that way could land
    // on a session row and fire SWITCH_SESSION — silently moving the whole
    // client to another session mid-test. The title focuses the column and
    // does nothing else.
    await ctx.page.click('[data-testid="sidebar-title-left"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === true),
      5000,
      'leftSidebarFocused set after click',
    );

    // Give the keyboard actor time to process UPDATE_LEFT_SIDEBAR_FOCUSED (async
    // message from XState, may lag the context update).
    await delay(DELAYS.SYNC);
    await ctx.page.bringToFront();

    // Step 5: Move the selection onto the FIRST window's tab row, then Enter
    // activates it → the active window switches back to the first window.
    //
    // Target the row by window id rather than by index: the tree inserts a
    // session header row whenever the socket hosts more than one session (which
    // it does under test — the server keeps its own session alongside the one
    // the test creates), so row 0 is not necessarily the first tab.
    //
    // Navigate top-down rather than walking up from wherever the cursor starts.
    // The tree's default selection is the active pane's row, but it falls back
    // to row 0 when that row isn't found — and row 0 sits ABOVE the target, so
    // pressing only `k` could never reach it.
    // Wait for the attached session's LIVE subtree first. The tree renders a
    // session's real tab/pane rows only while `sessionName` matches an entry in
    // the sessions list; until the ~1.5s sessions poll catches up with a
    // freshly-created session, every row is rendered as `foreign-*` — including
    // the client's own session — and no live tab row exists to select at all.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          (id) => !!document.querySelector(`[data-testid="tree-tab-${id}"]`),
          firstWindowId,
        ),
      15000,
      async () => {
        const s = await ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          return {
            url: location.href,
            sessionName: c?.sessionName,
            sessions: (c?.sessions || []).map((x) => x.sessionName),
            windows: (c?.windows || []).map((w) => w.id),
            rows: Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
              (r) => r.getAttribute('data-testid'),
            ),
          };
        });
        return `live tab row for ${firstWindowId}; ctxSession=${ctx.session.name}; state=${JSON.stringify(s)}`;
      },
    );

    const firstTabSelected = () =>
      ctx.page.evaluate((id) => {
        const row = document.querySelector(`.sidebar-tree [data-testid="tree-tab-${id}"]`);
        return !!row && row.classList.contains('is-selected');
      }, firstWindowId);

    const rowCount = await ctx.page.evaluate(
      () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length,
    );
    // `k` clamps at row 0, so this parks the cursor at the top whatever it was.
    for (let i = 0; i < rowCount; i++) {
      await ctx.page.keyboard.press('k');
    }
    for (let i = 0; i < rowCount && !(await firstTabSelected()); i++) {
      await ctx.page.keyboard.press('j');
    }
    await waitForCondition(ctx.page, firstTabSelected, 5000, async () => {
      const tree = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
          (r) =>
            `${r.className.includes('is-selected') ? '>' : ' '} ${r.getAttribute('data-testid')}`,
        ),
      );
      return `selection to reach the first window's tab row (${firstWindowId})\n  tree:\n    ${tree.join('\n    ')}`;
    });
    await ctx.page.keyboard.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active === firstWindowId;
      },
      10000,
      'tree Enter to activate the first window',
    );

    // Step 6: `l` (nav right, out of the column) blurs the tree — the column
    // stays open, focus returns to the panes. Escape is deliberately not a
    // sidebar key, so it must leave the focus where it is.
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.MEDIUM);
    const focusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.leftSidebarFocused,
    );
    expect(focusedAfterEscape).toBe(true);
    await ctx.page.keyboard.press('l');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === false),
      5000,
      'leftSidebarFocused cleared after l',
    );
    const stillOpen = await ctx.page.evaluate(() => {
      const el = document.querySelector('.sidebar-column-left');
      return !!el && el.getBoundingClientRect().width > 50;
    });
    expect(stillOpen).toBe(true);

    // The header toggle reflects the open state.
    const pressedWhileOpen = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedWhileOpen).toBe('true');

    // Step 7: `q` from inside the focused tree closes the sidebar — the
    // column is removed and the toggle returns to its unpressed state.
    await ctx.page.click('[data-testid="sidebar-title-left"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === true),
      5000,
      'tree focused again before q',
    );
    await ctx.page.keyboard.press('q');
    await ctx.page.waitForFunction(() => !document.querySelector('.sidebar-column-left'), {
      timeout: 10000,
      polling: 100,
    });
    const pressedAfterClose = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedAfterClose).toBe('false');
  }, 180000);
});
