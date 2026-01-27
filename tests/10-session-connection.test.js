/**
 * Category 10: Session & Connection
 *
 * Tests for session management, reconnection, multi-client, and flow control.
 */

const {
  createTestContext,
  delay,
  assertStateConsistency,
  DELAYS,
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
      ctx.session.splitHorizontal();
      const paneCountBefore = ctx.session.getPaneCount();

      // Reload page
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.SYNC);

      // State should persist
      const paneCountAfter = ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);

      await assertStateConsistency(ctx.page, ctx.session);
    });
    // Note: "Multiple windows survive refresh" removed as duplicate
    // Covered by session persist test - all tmux state (panes, windows) persists together

    test('Complex pane layout survives refresh', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupFourPanes();
      const paneCountBefore = ctx.session.getPaneCount();

      // Reload
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.SYNC);

      const paneCountAfter = ctx.session.getPaneCount();
      expect(paneCountAfter).toBe(paneCountBefore);

      await assertStateConsistency(ctx.page, ctx.session);
    });
  });

  // ====================
  // 10.2 Reconnection
  // ====================
  describe('10.2 Reconnection', () => {
    test('WebSocket connection established', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Page should load and connect
      const terminal = await ctx.page.$('[role="log"]');
      expect(terminal).not.toBeNull();
    });

    test('State is restored after reconnect', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      ctx.session.splitHorizontal();

      // Navigate away and back (simulates reconnect)
      await ctx.page.goto('about:blank');
      await delay(DELAYS.LONG);

      await ctx.navigateToSession();
      await delay(DELAYS.SYNC);

      // State should be restored
      expect(ctx.session.getPaneCount()).toBe(2);

      await assertStateConsistency(ctx.page, ctx.session);
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
        await page2.goto(`http://localhost:3853?session=${ctx.session.name}`, {
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
      ctx.session.sendKeys('"yes | head -500" Enter');
      await delay(DELAYS.SYNC);

      // App should still be functional
      expect(ctx.session.exists()).toBe(true);
    });
  });

  // ====================
  // 10.5 WebSocket Edge Cases
  // ====================
  describe('10.5 WebSocket Edge Cases', () => {
    test('UI updates when tmux state changes externally', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Get initial pane count from UI
      const initialCount = await ctx.page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return logs.length;
      });
      expect(initialCount).toBe(1);

      // Create a pane externally via tmux (not via UI)
      ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // UI should reflect the change via WebSocket state push
      const newCount = await ctx.page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return logs.length;
      });
      expect(newCount).toBe(2);
    });

    test('Multiple rapid state changes are handled', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Rapidly create multiple panes via tmux
      ctx.session.splitHorizontal();
      ctx.session.splitVertical();
      ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // UI should eventually show all 4 panes
      const paneCount = await ctx.page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return logs.length;
      });
      expect(paneCount).toBe(4);

      // Verify UI matches tmux state
      expect(paneCount).toBe(ctx.session.getPaneCount());
    });

    test('WebSocket reconnects after navigation', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create some state
      ctx.session.splitHorizontal();
      await delay(DELAYS.LONG);

      // Navigate away completely
      await ctx.page.goto('about:blank');
      await delay(DELAYS.LONG);

      // Make more changes while disconnected
      ctx.session.splitVertical();
      await delay(DELAYS.MEDIUM);

      // Navigate back
      await ctx.navigateToSession();
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
      await delay(DELAYS.SYNC);

      // UI should show current state (3 panes)
      const paneCount = await ctx.page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return logs.length;
      });
      expect(paneCount).toBe(3);
    });
  });

  // ====================
  // 10.6 Error Handling
  // ====================
  describe('10.6 Error Handling', () => {
    test('App handles session not found gracefully', async () => {
      if (ctx.skipIfNotReady()) return;

      // Try to connect to a non-existent session
      const nonExistentSession = 'nonexistent_session_' + Date.now();
      await ctx.page.goto(`http://localhost:3853?session=${nonExistentSession}`, {
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
      // Page may need reload to reconnect WebSocket
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });

      // Verify recovered
      const terminalAfter = await ctx.page.$('[role="log"]');
      expect(terminalAfter).not.toBeNull();
    });

    test('App handles invalid URL parameters', async () => {
      if (ctx.skipIfNotReady()) return;

      // Try various invalid parameters
      const invalidUrls = [
        'http://localhost:3853?session=',          // Empty session
        'http://localhost:3853?session=a/b/c',     // Invalid chars
        'http://localhost:3853?invalid=param',     // Wrong param
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
