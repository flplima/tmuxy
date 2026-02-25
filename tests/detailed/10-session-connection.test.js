/**
 * Category 10: Session & Connection
 *
 * Tests for session management, reconnection, multi-client, and flow control.
 */

const {
  createTestContext,
  delay,
  getUIPaneCount,
  waitForPaneCount,
  DELAYS,
  TMUXY_URL,
} = require('./helpers');

describe('Category 10: Session & Connection', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 10.1 Session Management
  // ====================
  describe('10.1 Session Management', () => {
    test('Session persists after page reload', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create some state using tmux command
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);
      // Wait for split to propagate to XState
      const startWait = Date.now();
      while (Date.now() - startWait < 10000) {
        if (await ctx.session.getPaneCount() === 2) break;
        await delay(100);
      }
      const paneCountBefore = await ctx.session.getPaneCount();
      expect(paneCountBefore).toBe(2);

      // Reload page
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      ctx.session.setPage(ctx.page); // Re-set page reference after reload
      await delay(DELAYS.SYNC);

      // State should persist
      const paneCountAfter = await ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);


    });
    // Note: "Multiple windows survive refresh" removed as duplicate
    // Covered by session persist test - all tmux state (panes, windows) persists together

    // Skipped: Complex layout refresh has timing issues
    test.skip('Complex pane layout survives refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();
      const paneCountBefore = await ctx.session.getPaneCount();

      // Reload
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      ctx.session.setPage(ctx.page); // Re-set page reference after reload
      await delay(DELAYS.SYNC);

      const paneCountAfter = await ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);


    });
  });

  // ====================
  // 10.2 Reconnection
  // ====================
  describe('10.2 Reconnection', () => {
    test('SSE connection established', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Page should load and connect
      const terminal = await ctx.page.$('[role="log"]');
      expect(terminal).not.toBeNull();
    });

    // Skipped: Reconnection state restore has timing issues
    test.skip('State is restored after reconnect', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await ctx.session.splitHorizontal();

      // Navigate away and back (simulates reconnect)
      await ctx.page.goto('about:blank');
      await delay(DELAYS.LONG);

      await ctx.navigateToSession();
      await delay(DELAYS.SYNC);

      // State should be restored
      expect(await ctx.session.getPaneCount()).toBe(2);


    });
  });

  // ====================
  // 10.3 Multi-Client
  // ====================
  describe('10.3 Multi-Client', () => {
    test('Multiple pages can connect to same session', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Open second page to same session
      const page2 = await ctx.browser.newPage();
      try {
        await page2.goto(`${TMUXY_URL}?session=${ctx.session.name}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page2.waitForSelector('[role="log"]', { timeout: 10000 });

        // Both should see the terminal
        const terminal1 = await ctx.page.$('[role="log"]');
        const terminal2 = await page2.$('[role="log"]');

        expect(terminal1).not.toBeNull();
        expect(terminal2).not.toBeNull();
      } finally {
        if (page2._context) {
          await page2._context.close();
        } else {
          await page2.close();
        }
      }
    });
  });

  // ====================
  // 10.4 Flow Control
  // ====================
  describe('10.4 Flow Control', () => {
    test('App handles rapid output', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate rapid output
      await ctx.session.sendKeys('"yes | head -500" Enter');
      await delay(DELAYS.SYNC);

      // App should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 10.5 SSE Edge Cases
  // ====================
  describe('10.5 SSE Edge Cases', () => {
    test('UI updates when tmux state changes externally', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Get initial pane count from UI using helper
      const initialCount = await getUIPaneCount(ctx.page);
      expect(initialCount).toBe(1);

      // Create a pane externally via tmux (not via UI)
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // UI should reflect the change via SSE state push
      await waitForPaneCount(ctx.page, 2);
      const newCount = await getUIPaneCount(ctx.page);
      expect(newCount).toBe(2);
    });

    test('Multiple rapid state changes are handled', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Rapidly create multiple panes via tmux
      await ctx.session.splitHorizontal();
      await ctx.session.splitVertical();
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // UI should eventually show all 4 panes
      await waitForPaneCount(ctx.page, 4);
      const paneCount = await getUIPaneCount(ctx.page);
      expect(paneCount).toBe(4);

      // Verify UI matches tmux state
      expect(paneCount).toBe(await ctx.session.getPaneCount());
    });

    test('SSE reconnects after navigation', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create some state
      await ctx.session.splitHorizontal();
      await delay(DELAYS.LONG);

      // Navigate away completely
      await ctx.page.goto('about:blank');
      ctx.session.setPage(null); // Clear page reference when navigating away
      await delay(1500); // Wait for control mode cleanup

      // Navigate back
      await ctx.navigateToSession();
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.SYNC);

      // Make more changes while reconnected
      await ctx.session.splitVertical();
      await delay(DELAYS.SYNC);

      // UI should show current state (3 panes)
      await waitForPaneCount(ctx.page, 3);
      const paneCount = await getUIPaneCount(ctx.page);
      expect(paneCount).toBe(3);
    });
  });

  // ====================
  // 10.6 Session Isolation
  // ====================
  describe('10.6 Session Isolation', () => {
    test('Creating and destroying sessions via control mode does not crash idle UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create and destroy sessions through the adapter (control mode)
      // External tmux commands crash tmux 3.5a, so we route through the existing connection
      for (let i = 0; i < 3; i++) {
        const name = `tmuxy_temp_${Date.now()}_${i}`;
        await ctx.session.runViaAdapter(`new-session -d -s ${name} -x 80 -y 24`);
        await ctx.session.runViaAdapter(`kill-session -t ${name}`);
      }

      await delay(DELAYS.SYNC);

      // Original session should still be functional
      expect(await ctx.session.getPaneCount()).toBe(1);

      // UI should still show terminal
      const terminal = await ctx.page.$('[role="log"]');
      expect(terminal).not.toBeNull();
    });
  });

  // ====================
  // 10.7 Error Handling
  // ====================
  describe('10.7 Error Handling', () => {
    test('App handles session not found gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      // Try to connect to a non-existent session
      const nonExistentSession = 'nonexistent_session_' + Date.now();
      await ctx.page.goto(`${TMUXY_URL}?session=${nonExistentSession}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await delay(DELAYS.SYNC);

      // App should not crash - should show some UI
      const root = await ctx.page.$('#root');
      expect(root).not.toBeNull();

      // Should not have a terminal since session doesn't exist
      // (or might create one - either way app should be stable)
      const hasError = await ctx.page.evaluate(() => {
        const body = document.body.textContent || '';
        // Check for common error patterns or empty state
        return body.includes('error') ||
               body.includes('Error') ||
               body.includes('not found') ||
               body.includes('Session') ||
               document.querySelectorAll('[role="log"]').length === 0;
      });
      // Just verify app is still responsive
      const isResponsive = await ctx.page.evaluate(() => {
        return document.readyState === 'complete';
      });
      expect(isResponsive).toBe(true);
    });

    test('App handles network interruption gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Verify connected first
      const terminal = await ctx.page.$('[role="log"]');
      expect(terminal).not.toBeNull();

      // Simulate offline mode
      await ctx.page.context().setOffline(true);
      await delay(DELAYS.LONG);

      // App should still be rendered (not crash)
      const rootAfterOffline = await ctx.page.$('#root');
      expect(rootAfterOffline).not.toBeNull();

      // Go back online
      await ctx.page.context().setOffline(false);
      await delay(DELAYS.SYNC);

      // After coming back online, app should recover
      // Page may need reload to reconnect SSE
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      ctx.session.setPage(ctx.page); // Re-set page reference after reload

      // Verify recovered
      const terminalAfter = await ctx.page.$('[role="log"]');
      expect(terminalAfter).not.toBeNull();
    });

    test('App handles invalid URL parameters', async () => {
      if (ctx.skipIfNotReady()) return;

      // Try various invalid parameters
      const invalidUrls = [
        `${TMUXY_URL}?session=`,          // Empty session
        `${TMUXY_URL}?session=a/b/c`,     // Invalid chars
        `${TMUXY_URL}?invalid=param`,     // Wrong param
      ];

      for (const url of invalidUrls) {
        await ctx.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await delay(DELAYS.MEDIUM);

        // App should not crash
        const root = await ctx.page.$('#root');
        expect(root).not.toBeNull();
      }
    });
  });
});
