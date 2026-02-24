/**
 * Category 9: Status Bar & UI
 *
 * Tests for status bar rendering, window tabs, and menu interactions.
 */

const {
  createTestContext,
  delay,
  focusPage,
  waitForWindowCount,
  DELAYS,
} = require('./helpers');

describe('Category 9: Status Bar & UI', () => {
  const ctx = createTestContext({ snapshot: true });

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 9.1 Status Bar Rendering
  // ====================
  describe('9.1 Status Bar Rendering', () => {
    test('Status bar is visible at bottom of page', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const statusBar = await ctx.page.$('.tmuxy-tmux-status');
      expect(statusBar).not.toBeNull();

      // Verify status bar has meaningful content and is visible
      const statusBarInfo = await ctx.page.evaluate(() => {
        const bar = document.querySelector('.tmuxy-tmux-status');
        if (!bar) return null;
        return {
          hasContent: bar.textContent.trim().length > 0,
          isVisible: bar.offsetHeight > 0 && bar.offsetWidth > 0,
        };
      });

      expect(statusBarInfo).not.toBeNull();
      expect(statusBarInfo.hasContent).toBe(true);
      expect(statusBarInfo.isVisible).toBe(true);
      // Note: Window tabs verified separately in "Window tab is rendered" test

      // Status bar should be at bottom
      const box = await statusBar.boundingBox();
      const viewport = await ctx.page.viewportSize();
      expect(box.y + box.height).toBeGreaterThan(viewport.height - 100);
    });

    test('Window tab is rendered in status bar', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const windowTab = await ctx.page.$('.tmuxy-tab');
      expect(windowTab).not.toBeNull();

      // Tab should have content
      const tabText = await windowTab.textContent();
      expect(tabText.length).toBeGreaterThan(0);
    });

    test('Active window tab has distinct styling from inactive tabs', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create a second window so we have both active and inactive tabs
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      const activeTab = await ctx.page.$('.tmuxy-tab-active');
      expect(activeTab).not.toBeNull();

      // Now we should have an inactive tab to compare against
      const inactiveTab = await ctx.page.$('.tmuxy-tab:not(.tmuxy-tab-active)');
      expect(inactiveTab).not.toBeNull();

      // Verify active tab has different styling from inactive tab
      const stylingInfo = await ctx.page.evaluate(() => {
        const active = document.querySelector('.tmuxy-tab-active');
        const inactive = document.querySelector('.tmuxy-tab:not(.tmuxy-tab-active)');
        if (!active || !inactive) return { canCompare: false };

        const activeStyle = getComputedStyle(active);
        const inactiveStyle = getComputedStyle(inactive);

        return {
          canCompare: true,
          bgDifferent: activeStyle.backgroundColor !== inactiveStyle.backgroundColor,
          fontWeightDifferent: activeStyle.fontWeight !== inactiveStyle.fontWeight,
          borderDifferent: activeStyle.borderColor !== inactiveStyle.borderColor,
          activeBackground: activeStyle.backgroundColor,
          inactiveBackground: inactiveStyle.backgroundColor,
        };
      });

      expect(stylingInfo.canCompare).toBe(true);

      // At least one styling difference should exist
      const hasDistinctStyling =
        stylingInfo.bgDifferent ||
        stylingInfo.fontWeightDifferent ||
        stylingInfo.borderDifferent;
      expect(hasDistinctStyling).toBe(true);
    });

    test('Session name is visible in status bar', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const statusBar = await ctx.page.$('.tmuxy-tmux-status');
      expect(statusBar).not.toBeNull();

      const statusText = await statusBar.textContent();
      // Status bar should contain the actual session name
      expect(statusText).toContain(ctx.session.name);
    });
  });

  // ====================
  // 9.2 Window Tab Interactions
  // ====================
  describe('9.2 Window Tab Interactions', () => {
    test('Click window tab switches windows', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create second window
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getWindowCount()).toBe(2);
      expect(await ctx.session.getCurrentWindowIndex()).toBe('2');

      // Find and click first window tab button
      const tabButtons = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add) .tmuxy-tab-button');
      expect(tabButtons.length).toBe(2);

      // Get the target window index from the first tab button's aria-label
      const firstTabLabel = await tabButtons[0].getAttribute('aria-label');
      const targetIndex = firstTabLabel.match(/Window (\d+)/)?.[1];

      await tabButtons[0].click();

      // Wait for the UI to reflect the window switch (active tab changes)
      await ctx.page.waitForFunction(
        (idx) => {
          const activeTab = document.querySelector('.tmuxy-tab-active .tmuxy-tab-button');
          if (!activeTab) return false;
          const label = activeTab.getAttribute('aria-label') || '';
          return label.includes(`Window ${idx}`);
        },
        targetIndex,
        { timeout: 10000, polling: 200 }
      );
      await delay(DELAYS.SYNC);

      // Should have switched to first window
      expect(await ctx.session.getCurrentWindowIndex()).toBe(targetIndex);


    });

    test('Multiple window tabs reflect window count', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create additional windows through WebSocket (safe with control mode)
      await ctx.session.newWindow();
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);

      // Switch back to first window
      await ctx.session.selectWindow(1);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 3);

      expect(await ctx.session.getWindowCount()).toBe(3);

      // UI should show 3 tabs
      const tabs = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      expect(tabs.length).toBe(3);
    });

    test('Window tab updates when window is renamed', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const newName = 'RENAMED_WINDOW';
      await ctx.session.renameWindow(newName);
      await delay(DELAYS.SYNC);

      // Tab should show new name
      const tabs = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      let foundName = false;
      for (const tab of tabs) {
        const text = await tmuxy-tab.textContent();
        if (text.includes(newName)) {
          foundName = true;
          break;
        }
      }
      expect(foundName).toBe(true);
    });
  });

  // ====================
  // 9.3 Window Close via UI
  // ====================
  describe('9.3 Window Close via UI', () => {
    test('Close button on window tab closes window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);
      expect(await ctx.session.getWindowCount()).toBe(2);

      // Close button only appears on hover - hover over the first tab
      const tabs = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      expect(tabs.length).toBe(2);
      await tabs[0].hover();
      await delay(DELAYS.SHORT);

      // Now find close button on the hovered tab
      const closeBtn = await ctx.page.$('.tmuxy-tab-close');
      expect(closeBtn).not.toBeNull();

      await closeBtn.click();
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getWindowCount()).toBe(1);

    });

    test('Tmux kill-window updates UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);
      expect(await ctx.session.getWindowCount()).toBe(2);

      // Close via tmux command
      await ctx.session.killWindow(2);
      await delay(DELAYS.SYNC);

      expect(await ctx.session.getWindowCount()).toBe(1);

    });
  });

  // ====================
  // 9.5 New Window Button
  // ====================
  describe('9.5 New Window Button', () => {
    // Skipped: UI sends 'new-window' directly through control mode which crashes tmux 3.5a
    // The tmux new-window command works via the split-window + break-pane workaround in TmuxTestSession
    test.skip('New window button creates window', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialCount = await ctx.session.getWindowCount();

      // Find new window button (class is .tab-add with aria-label "Create new window")
      const newWindowBtn = await ctx.page.$('.tmuxy-tab-add');
      expect(newWindowBtn).not.toBeNull();

      await newWindowBtn.click();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, initialCount + 1);

      expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);
    });

    test('Tmux new-window updates UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const initialCount = await ctx.session.getWindowCount();

      // Create via tmux command
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, initialCount + 1);

      expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);
    });
  });

  // ====================
  // 9.6 Status Bar Updates
  // ====================
  describe('9.6 Status Bar Updates', () => {
    test('Window tabs update when windows are added', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const tabsBefore = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      const countBefore = tabsBefore.length;

      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, countBefore + 1);

      const tabsAfter = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      expect(tabsAfter.length).toBe(countBefore + 1);
    });

    test('Window tabs update when windows are removed', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create one additional window
      await ctx.session.newWindow();
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 2);

      const tabsBefore = await ctx.page.$$('.tmuxy-tab:not(.tmuxy-tab-add)');
      expect(tabsBefore.length).toBe(2);
      expect(await ctx.session.getWindowCount()).toBe(2);

      // Kill the current window (window 2)
      await ctx.session.killWindow(2);
      await delay(DELAYS.SYNC);
      await waitForWindowCount(ctx.page, 1);

      expect(await ctx.session.getWindowCount()).toBe(1);
    });
  });
});
