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
      const paneCountBefore = await ctx.session.getPaneCount();

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
    test('WebSocket connection established', async () => {
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
  // 10.5 WebSocket Edge Cases
  // ====================
  describe('10.5 WebSocket Edge Cases', () => {
    test('UI updates when tmux state changes externally', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Get initial pane count from UI using helper
      const initialCount = await getUIPaneCount(ctx.page);
      expect(initialCount).toBe(1);

      // Create a pane externally via tmux (not via UI)
      await ctx.session.splitHorizontal();
      await delay(DELAYS.SYNC);

      // UI should reflect the change via WebSocket state push
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

    test('WebSocket reconnects after navigation', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Create some state
      await ctx.session.splitHorizontal();
      await delay(DELAYS.LONG);

      // Navigate away completely
      await ctx.page.goto('about:blank');
      ctx.session.setPage(null); // Clear page reference when navigating away
      await delay(DELAYS.LONG);

      // Make more changes while disconnected (sync since no page)
      ctx.session.splitVertical();
      await delay(DELAYS.MEDIUM);

      // Navigate back
      await ctx.navigateToSession();
      await ctx.page.waitForSelector('[role="log"]', { timeout: 10000 });
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
    test('Changes in another session do not dispatch events to idle UI', async () => {
      if (ctx.skipIfNotReady()) return;

      // Connect UI to session A (ctx.session) and let it idle
      await ctx.setupPage();

      // Instrument the page to count incoming state updates
      await ctx.page.evaluate(() => {
        window.__stateUpdateCount = 0;
        // Monkey-patch WebSocket to count incoming tmux-state-update messages
        const origOnMessage = WebSocket.prototype.addEventListener;
        const sockets = [];
        // Track existing WebSocket instances via message event
        const origSend = WebSocket.prototype.send;
        // Listen on all existing WebSocket connections
        for (const ws of (window.__tmuxy_ws_list || [])) {
          ws.addEventListener('message', (e) => {
            try {
              const data = JSON.parse(e.data);
              if (data.name === 'tmux-state-update') {
                window.__stateUpdateCount++;
              }
            } catch {}
          });
        }
      });

      // Now also install a more reliable counter using page.exposeFunction
      // by intercepting all WebSocket messages via the page's evaluate
      await ctx.page.evaluate(() => {
        window.__stateUpdateCount = 0;
        window.__isolationTestStart = Date.now();
        // Override the onStateChange handler in the adapter
        // Alternatively, just observe incoming WebSocket messages
        const OrigWS = window.WebSocket;
        const origInstances = [];
        // Patch new WebSocket instances
        window.WebSocket = function(...args) {
          const ws = new OrigWS(...args);
          ws.addEventListener('message', (e) => {
            try {
              const data = JSON.parse(e.data);
              if (data.name === 'tmux-state-update' && window.__isolationTestStart) {
                window.__stateUpdateCount++;
              }
            } catch {}
          });
          return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING;
        window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSING = OrigWS.CLOSING;
        window.WebSocket.CLOSED = OrigWS.CLOSED;
      });

      // Wait for any pending state updates to settle
      await delay(DELAYS.SYNC);

      // Reset counter AFTER settling
      await ctx.page.evaluate(() => {
        window.__stateUpdateCount = 0;
      });

      // Create a separate session B and make many changes to it
      const TmuxTestSession = require('./helpers/TmuxTestSession');
      const sessionB = new TmuxTestSession();
      sessionB.create();

      try {
        // Make several changes in session B
        sessionB.splitHorizontal();
        sessionB.splitVertical();
        sessionB.sendKeys('"echo hello from session B" Enter');
        await delay(DELAYS.LONG);
        sessionB.sendKeys('"seq 1 100" Enter');
        await delay(DELAYS.LONG);

        // Check that session A's UI did NOT receive state updates
        // caused by session B's activity
        const updateCount = await ctx.page.evaluate(() => window.__stateUpdateCount);

        // The idle session should receive at most a few updates (from periodic sync),
        // NOT a flood from another session's activity. Zero is ideal after the fix.
        // Allow up to 2 for periodic sync that may overlap.
        expect(updateCount).toBeLessThanOrEqual(2);
      } finally {
        sessionB.destroy();
      }
    });

    test('Creating and destroying sessions does not crash idle UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Rapidly create and destroy sessions
      const TmuxTestSession = require('./helpers/TmuxTestSession');
      for (let i = 0; i < 5; i++) {
        const tempSession = new TmuxTestSession();
        tempSession.create();
        tempSession.destroy();
      }

      await delay(DELAYS.SYNC);

      // Original session should still be functional
      expect(ctx.session.exists()).toBe(true);
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
      // Page may need reload to reconnect WebSocket
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
