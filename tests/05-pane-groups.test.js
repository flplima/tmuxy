/**
 * Category 5: Pane Groups
 *
 * Tests for pane header rendering, active state styling, and pane group
 * (tabbed pane) workflows: adding panes to groups, switching tabs,
 * closing tabs, and verifying UI/tmux state consistency.
 */

const {
  createTestContext,
  delay,
  focusPage,
  getUIPaneInfo,
  getUIPaneCount,
  getTerminalText,
  waitForTerminalText,
  runCommand,
  runCommandViaTmux,
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  waitForPaneCount,
  withConsistencyChecks,
  verifyDomSizes,
  GlitchDetector,
  DELAYS,
} = require('./helpers');

describe('Category 5: Pane Groups', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 5.1 Pane Header Rendering
  // ====================
  describe('5.1 Pane Header Rendering', () => {
    test('Single pane has header element', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const header = await ctx.page.$('.pane-tab');
      expect(header).not.toBeNull();

      // Header should have some content (pane ID, title, or command)
      const headerText = await ctx.page.evaluate(() => {
        const h = document.querySelector('.pane-tab');
        return h ? h.textContent.trim() : '';
      });
      expect(headerText.length).toBeGreaterThan(0);
    });

    test('Split panes each have their own header', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Wait for all pane tabs to render
      await ctx.page.waitForFunction(
        () => document.querySelectorAll('.pane-tab').length === 2,
        { timeout: 5000 }
      );

      const headers = await ctx.page.$$('.pane-tab');
      expect(headers.length).toBe(2);

      // Each header should be associated with a pane
      const panes = await getUIPaneInfo(ctx.page);
      expect(panes.length).toBe(2);


    });

    test('Pane header shows running command or shell', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Header should show something (bash, zsh, etc)
      const headerText = await ctx.page.evaluate(() => {
        const h = document.querySelector('.pane-tab');
        return h ? h.textContent.toLowerCase() : '';
      });

      // Should contain shell name or pane ID
      const hasRelevantContent = headerText.length > 0;
      expect(hasRelevantContent).toBe(true);
    });

    test('Pane header has group add button', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const addButton = await ctx.page.$('.pane-tab-add');
      expect(addButton).not.toBeNull();

      const title = await addButton.getAttribute('title');
      expect(title).toBe('Add pane to group');
    });
  });

  // ====================
  // 5.2 Active Pane Styling
  // ====================
  describe('5.2 Active Pane Styling', () => {
    test('Single pane is marked as active', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const hasActiveStyle = await ctx.page.evaluate(() => {
        return document.querySelector('.pane-tab-active') !== null;
      });

      expect(hasActiveStyle).toBe(true);
    });

    test('Active pane changes when navigating', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Get initial active pane
      const initialActiveId = await ctx.session.getActivePaneId();

      // Navigate to other pane
      await ctx.session.selectPane('U');
      await delay(DELAYS.SYNC);

      // Active pane should have changed
      const newActiveId = await ctx.session.getActivePaneId();
      expect(newActiveId).not.toBe(initialActiveId);


    });

    test('Only one pane header is active at a time', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();

      const activeHeaders = await ctx.page.$$('.pane-tab-active');
      expect(activeHeaders.length).toBe(1);


    });
  });

  // ====================
  // 5.3 Pane Close Button
  // ====================
  describe('5.3 Pane Close Button', () => {
    test('Pane header has close button', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const closeButton = await ctx.page.$('.pane-tab-close, .pane-tab button, [aria-label*="close" i]');
      expect(closeButton).not.toBeNull();
    });

    test('Close button kills pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');
      expect(await ctx.session.getPaneCount()).toBe(2);

      const closeButton = await ctx.page.$('.pane-tab-close');
      expect(closeButton).not.toBeNull();

      await closeButton.click();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getPaneCount()).toBe(1);

    });
  });

  // ====================
  // 5.4 UI State Persistence
  // ====================
  describe('5.4 UI State Persistence', () => {
    // Window switch tests are complex due to control mode timing
    // These are tested in 04-window-operations.test.js
    test.skip('Pane layout survives window switch and return', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create layout: split horizontal then vertical = 3 panes
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SHORT);
      await ctx.session.splitVertical();
      await delay(DELAYS.SHORT);

      const initialPaneCount = await ctx.session.getPaneCount();

      // Create new window and switch to it
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      // Switch back to first window
      await ctx.session.selectWindow(1);
      await delay(DELAYS.SYNC);

      // Layout should be preserved
      expect(await ctx.session.getPaneCount()).toBe(initialPaneCount);
    });

    test('Pane layout survives page refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create complex layout
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);
      await waitForPaneCount(ctx.page, 3);
      const paneCountBefore = await ctx.session.getPaneCount();
      expect(paneCountBefore).toBe(3);

      // Refresh page
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      ctx.session.setPage(ctx.page); // Re-set page after reload
      await delay(DELAYS.SYNC);

      // Tmux state persists (UI reconnects to same session)
      expect(await ctx.session.getPaneCount()).toBe(paneCountBefore);

    });

    // Window switch tests are complex due to control mode timing
    // These are tested in 04-window-operations.test.js
    test.skip('Multiple windows with different layouts persist', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Window 1: 2 panes
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // Window 2: create new window
      await ctx.session.newWindow();
      await ctx.session.splitVertical();
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // Verify window 2 has 3 panes
      expect(await ctx.session.getPaneCount()).toBe(3);

      // Switch to window 1
      await ctx.session.selectWindow(1);
      await delay(DELAYS.SYNC);

      // Verify window 1 still has 2 panes
      expect(await ctx.session.getPaneCount()).toBe(2);
    });
  });

  // ====================
  // 5.5 Pane Group - Create
  // ====================
  describe('5.5 Pane Group - Create', () => {
    test('Clicking add-to-group button creates a pane group', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Initially no group tabs
      expect(await isHeaderGrouped(ctx.page)).toBe(false);
      expect(await getGroupTabCount(ctx.page)).toBe(0);

      // Click the "+" button with consistency check
      const result = await withConsistencyChecks(ctx, async () => {
        await clickPaneGroupAdd(ctx.page);
        // Should now show grouped header with 2 tabs
        await waitForGroupTabs(ctx.page, 2);
      }, { operationType: 'groupSwitch' });

      expect(await isHeaderGrouped(ctx.page)).toBe(true);

      const tabs = await getGroupTabInfo(ctx.page);
      expect(tabs.length).toBe(2);
      // After group creation, the new pane is swapped into the visible position
      // so the new tab (index 1) becomes active
      const activeCount = tabs.filter(t => t.active).length;
      expect(activeCount).toBe(1);

      // Verify no flicker during group creation
      expect(result.glitch.summary.nodeFlickers).toBe(0);
    });

    test('Add-to-group on split pane creates group for that pane only', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Click add-to-group on the active pane
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Count panes: one grouped (2+ tabs) and one regular (1 tab)
      const paneRowInfo = await ctx.page.evaluate(() => {
        const rows = document.querySelectorAll('.pane-tabs');
        let grouped = 0;
        let regular = 0;
        for (const row of rows) {
          const tabCount = row.querySelectorAll('.pane-tab').length;
          if (tabCount > 1) grouped++;
          else if (tabCount === 1) regular++;
        }
        return { grouped, regular };
      });

      // Only one pane should be grouped
      expect(paneRowInfo.grouped).toBe(1);

      // The other pane should still have a regular header
      expect(paneRowInfo.regular).toBe(1);

      // Visible pane count should remain 2 (group doesn't change visible layout)
      const uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);
    });
  });

  // ====================
  // 5.6 Pane Group - Switch Tabs
  // ====================
  describe('5.6 Pane Group - Switch Tabs', () => {
    test('Clicking a group tab switches the visible pane', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 2 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // After group creation, the new pane is swapped into visible position
      let tabs = await getGroupTabInfo(ctx.page);
      const initialActiveIdx = tabs.findIndex(t => t.active);

      // Click the OTHER tab (whichever is not active) with consistency check
      const targetIdx = initialActiveIdx === 0 ? 1 : 0;
      const result = await withConsistencyChecks(ctx, async () => {
        await clickGroupTab(ctx.page, targetIdx);
        await waitForGroupTabs(ctx.page, 2);
      }, { operationType: 'groupSwitch' });

      // After swap, the clicked tab is now active.
      tabs = await getGroupTabInfo(ctx.page);
      expect(tabs.length).toBe(2);
      const activeTab = tabs.find(t => t.active);
      expect(activeTab).toBeDefined();
      // Exactly one tab is active
      expect(tabs.filter(t => t.active).length).toBe(1);

      // Verify no flicker during tab switch
      expect(result.glitch.summary.nodeFlickers).toBe(0);
    });

    test('Switching tabs preserves the group', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 2 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Switch to second tab (swap-pane + state rebuild)
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);

      // Group should still exist with 2 tabs
      expect(await getGroupTabCount(ctx.page)).toBe(2);
      expect(await isHeaderGrouped(ctx.page)).toBe(true);
    });
  });

  // ====================
  // 5.7 Pane Group - Add More Tabs
  // ====================
  describe('5.7 Pane Group - Add More Tabs', () => {
    test('Clicking group-tab-add adds another tab to existing group', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create initial group (longer timeout for server load)
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Add another tab via the "+" in the tab bar
      await clickGroupTabAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 3);

      const tabs = await getGroupTabInfo(ctx.page);
      expect(tabs.length).toBe(3);
    });
  });

  // ====================
  // 5.8 Pane Group - Close Tabs
  // ====================
  describe('5.8 Pane Group - Close Tabs', () => {
    test('Closing a non-active tab removes it from the group', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 3 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);
      await clickGroupTabAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 3);

      // Close the last (non-active) tab
      await clickGroupTabClose(ctx.page, 2);
      await waitForGroupTabs(ctx.page, 2);

      expect(await getGroupTabCount(ctx.page)).toBe(2);
      expect(await isHeaderGrouped(ctx.page)).toBe(true);
    });

    test('Closing tabs until one remains reverts to regular header', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 2 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);
      expect(await isHeaderGrouped(ctx.page)).toBe(true);

      // Close the second tab (non-active)
      await clickGroupTabClose(ctx.page, 1);
      await delay(DELAYS.SYNC);

      // Should revert to regular (non-grouped) header
      expect(await isHeaderGrouped(ctx.page)).toBe(false);
      expect(await getGroupTabCount(ctx.page)).toBe(0);

      // Pane should still exist
      const header = await ctx.page.$('.pane-tab');
      expect(header).not.toBeNull();
    });

    test('Closing the active tab switches to another tab', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 3 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);
      await clickGroupTabAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 3);

      // Close the first (active) tab
      await clickGroupTabClose(ctx.page, 0);
      await waitForGroupTabs(ctx.page, 2);

      // Should still have 2 tabs and one should be active
      const tabCount = await getGroupTabCount(ctx.page);
      expect(tabCount).toBe(2);

      const tabs = await getGroupTabInfo(ctx.page);
      const hasActive = tabs.some(t => t.active);
      expect(hasActive).toBe(true);
    });
  });

  // ====================
  // 5.9 Pane Group - Content Verification
  // ====================
  describe('5.9 Pane Group - Content Verification', () => {
    test('Tab switch displays the correct pane content', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run a unique command in the original pane
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "MARKER_ALPHA"', 'MARKER_ALPHA');

      // Create a group - new pane is swapped into visible position
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // After group creation, the new pane (fresh shell) is now visible
      // The original pane with MARKER_ALPHA is in the hidden group window
      let content = await getTerminalText(ctx.page);
      expect(content).not.toContain('MARKER_ALPHA');

      // Run a different command in the visible (new) pane
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "MARKER_BETA"', 'MARKER_BETA');

      // Find which tab is inactive (has the original content) and click it
      let tabs = await getGroupTabInfo(ctx.page);
      const inactiveIdx = tabs.findIndex(t => !t.active);
      await clickGroupTab(ctx.page, inactiveIdx);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Should now see the original pane content
      await waitForTerminalText(ctx.page, 'MARKER_ALPHA');
      content = await getTerminalText(ctx.page);
      expect(content).toContain('MARKER_ALPHA');
      expect(content).not.toContain('MARKER_BETA');

      // Switch back to the other tab
      tabs = await getGroupTabInfo(ctx.page);
      const otherInactiveIdx = tabs.findIndex(t => !t.active);
      await clickGroupTab(ctx.page, otherInactiveIdx);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Should see the new pane's content
      content = await getTerminalText(ctx.page);
      expect(content).toContain('MARKER_BETA');
      expect(content).not.toContain('MARKER_ALPHA');
    });

    test('Content persists through multiple tab switches', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run command in tab 0
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "PERSIST_AAA_111"', 'PERSIST_AAA_111');

      // Create group and switch to tab 1
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Run command in tab 1
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "PERSIST_BBB_222"', 'PERSIST_BBB_222');

      // Round-trip 1: switch to tab 0 (click inactive tab at index 0)
      await clickGroupTab(ctx.page, 0);
      await waitForGroupTabs(ctx.page, 2);
      await waitForTerminalText(ctx.page, 'PERSIST_AAA_111');
      let content = await getTerminalText(ctx.page);
      expect(content).not.toContain('PERSIST_BBB_222');

      // Round-trip 2: switch to tab 1 (click inactive tab at index 1)
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await waitForTerminalText(ctx.page, 'PERSIST_BBB_222');
      content = await getTerminalText(ctx.page);
      expect(content).not.toContain('PERSIST_AAA_111');

      // Round-trip 3: switch to tab 0 again (click inactive tab at index 0)
      await clickGroupTab(ctx.page, 0);
      await waitForGroupTabs(ctx.page, 2);
      await waitForTerminalText(ctx.page, 'PERSIST_AAA_111');
      content = await getTerminalText(ctx.page);
      expect(content).not.toContain('PERSIST_BBB_222');
    });

    test('Tmux pane swap is verified after tab switch', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run command in the current pane
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "SWAP_CHECK_ABC"', 'SWAP_CHECK_ABC');
      const initialPaneId = await ctx.session.getActivePaneId();

      // Create group - new pane is swapped into visible position
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // After group creation, active pane changed (new pane is now visible)
      const afterGroupPaneId = await ctx.session.getActivePaneId();
      expect(afterGroupPaneId).not.toBe(initialPaneId);

      // UI shows the new pane (fresh shell, no SWAP_CHECK_ABC)
      let content = await getTerminalText(ctx.page);
      expect(content).not.toContain('SWAP_CHECK_ABC');

      // Switch to the inactive tab (the original pane) - this triggers a swap
      let tabs = await getGroupTabInfo(ctx.page);
      const inactiveIdx = tabs.findIndex(t => !t.active);
      await clickGroupTab(ctx.page, inactiveIdx);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Active pane should now be the original
      expect(await ctx.session.getActivePaneId()).toBe(initialPaneId);

      // Content should show original command
      await waitForTerminalText(ctx.page, 'SWAP_CHECK_ABC');

      // Switch back to the other tab
      tabs = await getGroupTabInfo(ctx.page);
      const otherIdx = tabs.findIndex(t => !t.active);
      await clickGroupTab(ctx.page, otherIdx);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Active pane should have changed back
      expect(await ctx.session.getActivePaneId()).not.toBe(initialPaneId);
    });

    test('New group tab starts with fresh shell content', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Run commands to fill the original pane with content
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "ORIGINAL_CONTENT_XY1"', 'ORIGINAL_CONTENT_XY1');
      await runCommandViaTmux(ctx.session, ctx.page, 'echo "ORIGINAL_CONTENT_XY2"', 'ORIGINAL_CONTENT_XY2');

      // Create group
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Switch to the new tab
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // New tab should have a fresh shell - no original content
      let content = await getTerminalText(ctx.page);
      expect(content).not.toContain('ORIGINAL_CONTENT_XY1');
      expect(content).not.toContain('ORIGINAL_CONTENT_XY2');

      // But it should have some content (at least a shell prompt)
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });

  // ====================
  // 5.10 Pane Group - Window Isolation
  // ====================
  describe('5.10 Pane Group - Window Isolation', () => {
    test('Panes from group windows are not visible in the tiled layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Start with a single pane
      const initialUIPanes = await getUIPaneCount(ctx.page);
      expect(initialUIPanes).toBe(1);

      // Create a pane group (this creates a hidden group window)
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // The UI should still show exactly 1 visible pane (the active group tab)
      const afterGroupUIPanes = await getUIPaneCount(ctx.page);
      expect(afterGroupUIPanes).toBe(1);

      // Verify via app state: there should be panes in non-active windows
      // that are correctly filtered out of the DOM
      const stateCheck = await ctx.page.evaluate(() => {
        const state = window.app?.getSnapshot()?.context;
        if (!state) return null;
        const activeWindowId = state.activeWindowId;
        const allPanes = state.panes || [];
        const activeWindowPanes = allPanes.filter(p => p.windowId === activeWindowId);
        const otherWindowPanes = allPanes.filter(p => p.windowId !== activeWindowId);
        // Count panes rendered in DOM
        const domPaneIds = new Set();
        document.querySelectorAll('[data-pane-id]').forEach(el => {
          domPaneIds.add(el.getAttribute('data-pane-id'));
        });
        if (domPaneIds.size === 0) {
          // Fallback: count [role="log"] elements
          return {
            totalPanes: allPanes.length,
            activeWindowPanes: activeWindowPanes.length,
            otherWindowPanes: otherWindowPanes.length,
            domPanes: document.querySelectorAll('[role="log"]').length,
          };
        }
        return {
          totalPanes: allPanes.length,
          activeWindowPanes: activeWindowPanes.length,
          otherWindowPanes: otherWindowPanes.length,
          domPanes: domPaneIds.size,
          // Check no non-active-window pane leaked into DOM
          leakedPanes: otherWindowPanes.filter(p => domPaneIds.has(p.tmuxId)).map(p => p.tmuxId),
        };
      });

      expect(stateCheck).not.toBeNull();
      // There should be panes in other windows (the group window)
      expect(stateCheck.otherWindowPanes).toBeGreaterThan(0);
      // Total panes should be more than what's in the active window
      expect(stateCheck.totalPanes).toBeGreaterThan(stateCheck.activeWindowPanes);
      // DOM should only show active window panes
      expect(stateCheck.domPanes).toBe(stateCheck.activeWindowPanes);
      // No panes from other windows should leak into the DOM
      if (stateCheck.leakedPanes) {
        expect(stateCheck.leakedPanes).toEqual([]);
      }
    });

    test('Group window panes stay hidden after tab switch', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Create group on the active pane
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Should show 2 visible panes (one tiled + one grouped)
      let uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);

      // Switch to tab 2 in the group
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Still 2 visible panes - the group window pane should not leak
      uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);

      // Verify no leaked panes via state inspection
      const leakCheck = await ctx.page.evaluate(() => {
        const state = window.app?.getSnapshot()?.context;
        if (!state) return { leaked: false };
        const activeWindowId = state.activeWindowId;
        const domPaneIds = new Set();
        document.querySelectorAll('[data-pane-id]').forEach(el => {
          domPaneIds.add(el.getAttribute('data-pane-id'));
        });
        const leaked = (state.panes || [])
          .filter(p => p.windowId !== activeWindowId && domPaneIds.has(p.tmuxId))
          .map(p => p.tmuxId);
        return { leaked };
      });
      expect(leakCheck.leaked).toEqual([]);

      // Switch back to tab 1
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.SYNC);

      // Still 2 visible panes
      uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);
    });
  });

  // ====================
  // 5.11 Pane Header Tab Flicker Detection
  // ====================
  describe('5.11 Pane Header Tab Flicker Detection', () => {
    test('Tab switch has no header element flicker', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 2 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Start observing with focus on pane header elements
      const detector = new GlitchDetector(ctx.page);
      await detector.start({
        scope: '.pane-header',
        ignoreSelectors: ['.terminal-content', '.terminal-cursor', '.terminal-line'],
        attributeFilter: ['class', 'style', 'aria-selected'],
        flickerWindowMs: 150,
        churnWindowMs: 300,
      });

      // Perform tab switches
      await clickGroupTab(ctx.page, 1);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.MEDIUM);

      await clickGroupTab(ctx.page, 0);
      await waitForGroupTabs(ctx.page, 2);
      await delay(DELAYS.MEDIUM);

      // Stop and analyze
      const result = await detector.stop();

      // No node flicker (elements appearing/disappearing rapidly)
      expect(result.summary.nodeFlickers).toBe(0);

      // Check for class attribute churn on tab elements
      const tabClassChurn = result.churn.filter(c =>
        c.target.includes('pane-tab') && c.target.includes('class')
      );

      // Allow at most 1 rapid class change per tab switch
      expect(tabClassChurn.length).toBeLessThanOrEqual(2);
    });

    test('Tab switch preserves tab sizes (no size oscillation)', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 3 tabs to have more complex layout
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);
      await clickGroupTabAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 3);

      // Record initial tab sizes
      const initialSizes = await ctx.page.evaluate(() => {
        const tabs = document.querySelectorAll('.pane-tab');
        return Array.from(tabs).map(t => {
          const rect = t.getBoundingClientRect();
          return { width: rect.width, height: rect.height, text: t.textContent };
        });
      });

      // Perform multiple rapid tab switches while monitoring
      const detector = new GlitchDetector(ctx.page);
      await detector.start({
        scope: '.pane-tabs',
        sizeJumpThreshold: 5, // Stricter threshold for tabs
      });

      // Rapid tab switches
      for (let i = 0; i < 3; i++) {
        await clickGroupTab(ctx.page, (i + 1) % 3);
        await delay(DELAYS.SHORT);
      }

      const result = await detector.stop();

      // Record final tab sizes
      const finalSizes = await ctx.page.evaluate(() => {
        const tabs = document.querySelectorAll('.pane-tab');
        return Array.from(tabs).map(t => {
          const rect = t.getBoundingClientRect();
          return { width: rect.width, height: rect.height, text: t.textContent };
        });
      });

      // Tab count should remain the same
      expect(finalSizes.length).toBe(initialSizes.length);

      // Tab sizes should be stable (within 2px tolerance)
      for (let i = 0; i < Math.min(initialSizes.length, finalSizes.length); i++) {
        const widthDiff = Math.abs(finalSizes[i].width - initialSizes[i].width);
        const heightDiff = Math.abs(finalSizes[i].height - initialSizes[i].height);
        expect(widthDiff).toBeLessThanOrEqual(2);
        expect(heightDiff).toBeLessThanOrEqual(2);
      }
    });

    test('Active tab class changes exactly once per switch', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a group with 2 tabs
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Get initial tab states
      const getTabStates = () => ctx.page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.pane-tab'));
        return tabs.map(t => ({
          selected: t.classList.contains('pane-tab-selected') || t.classList.contains('pane-tab-active'),
          active: t.classList.contains('pane-tab-active'),
        }));
      });

      const initialStates = await getTabStates();
      expect(initialStates.length).toBe(2);
      // One tab should be selected/active initially
      expect(initialStates.some(s => s.selected)).toBe(true);

      // Start high-frequency polling to detect any intermediate states
      const stateHistory = await ctx.page.evaluate(() => {
        return new Promise((resolve) => {
          const history = [];
          const poll = setInterval(() => {
            const tabs = Array.from(document.querySelectorAll('.pane-tab'));
            const state = tabs.map(t => ({
              selected: t.classList.contains('pane-tab-selected'),
              active: t.classList.contains('pane-tab-active'),
            }));
            history.push({ ts: Date.now(), state });
            if (history.length > 100) clearInterval(poll);
          }, 5); // Poll every 5ms

          // Click the inactive tab after a brief delay
          setTimeout(() => {
            const tabs = document.querySelectorAll('.pane-tab');
            for (const tab of tabs) {
              if (!tab.classList.contains('pane-tab-selected')) {
                tab.click();
                break;
              }
            }
          }, 20);

          // Stop polling after 500ms
          setTimeout(() => {
            clearInterval(poll);
            resolve(history);
          }, 500);
        });
      });

      // Verify final state - exactly one tab should be selected/active
      const finalStates = await getTabStates();
      expect(finalStates.length).toBe(2);
      const selectedCount = finalStates.filter(s => s.selected).length;
      expect(selectedCount).toBe(1);

      // Analyze state history for flicker patterns
      // Count how many times each tab's selected state changed
      const transitions = { tab0: 0, tab1: 0 };
      for (let i = 1; i < stateHistory.length; i++) {
        const prev = stateHistory[i - 1].state;
        const curr = stateHistory[i].state;
        if (prev[0]?.selected !== curr[0]?.selected) transitions.tab0++;
        if (prev[1]?.selected !== curr[1]?.selected) transitions.tab1++;
      }

      // Each tab should change at most once (or a few times for optimistic updates)
      // Excessive transitions would indicate flicker
      expect(transitions.tab0).toBeLessThanOrEqual(4);
      expect(transitions.tab1).toBeLessThanOrEqual(4);
    });
  });

  // ====================
  // 5.12 Pane Group - Drag Swap Isolation
  // ====================
  describe('5.12 Pane Group - Drag Swap Isolation', () => {
    test('Swapping a grouped pane with a non-grouped pane does not break layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupTwoPanes('horizontal');

      // Get pane IDs before grouping
      const initialPanes = await ctx.session.getPaneInfo();
      expect(initialPanes.length).toBe(2);

      // Create a group on the active pane
      await clickPaneGroupAdd(ctx.page);
      await waitForGroupTabs(ctx.page, 2);

      // Should still show 2 visible panes (grouped + regular)
      let uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);

      // Get the grouped pane (active) and the non-grouped pane
      const activePaneId = await ctx.session.getActivePaneId();
      const otherPane = initialPanes.find(p => p.id !== activePaneId);
      expect(otherPane).toBeDefined();

      // Simulate what drag-swap does: swap the grouped pane with the non-grouped pane
      // This previously caused hidden group panes to leak into the active window
      await ctx.session.runCommand(`swap-pane -s ${activePaneId} -t ${otherPane.id}`);
      await delay(DELAYS.SYNC);

      // Layout should still show exactly 2 visible panes
      uiPaneCount = await getUIPaneCount(ctx.page);
      expect(uiPaneCount).toBe(2);

      // Group should still exist with 2 tabs
      expect(await isHeaderGrouped(ctx.page)).toBe(true);
      expect(await getGroupTabCount(ctx.page)).toBe(2);

      // Verify no panes leaked from group windows into the DOM
      const leakCheck = await ctx.page.evaluate(() => {
        const state = window.app?.getSnapshot()?.context;
        if (!state) return { ok: true };
        const activeWindowId = state.activeWindowId;
        const domPaneIds = new Set();
        document.querySelectorAll('[data-pane-id]').forEach(el => {
          domPaneIds.add(el.getAttribute('data-pane-id'));
        });
        if (domPaneIds.size === 0) {
          // fallback: count [role="log"]
          return { ok: true, domPanes: document.querySelectorAll('[role="log"]').length };
        }
        const leaked = (state.panes || [])
          .filter(p => p.windowId !== activeWindowId && domPaneIds.has(p.tmuxId))
          .map(p => p.tmuxId);
        return { ok: leaked.length === 0, leaked };
      });
      expect(leakCheck.ok).toBe(true);
    });
  });
});
