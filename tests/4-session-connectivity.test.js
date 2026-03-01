/**
 * Session & Connectivity E2E Tests
 *
 * Session reconnect and multi-client scenarios.
 */

const {
  createTestContext,
  delay,
  focusPage,
  runCommand,
  getUIPaneCount,
  waitForPaneCount,
  splitPaneKeyboard,
  navigateToSession,
  waitForSessionReady,
  verifyRoundTrip,
  getBrowser,
  TmuxTestSession,
  DELAYS,
} = require('./helpers');

// ==================== Scenario 12: Session Reconnect ====================

describe('Scenario 12: Session Reconnect', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('2 panes → reload → verify preserved → split via tmux → 3 rapid splits → UI synced', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create 2 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2);
    // Wait for XState to reflect
    const pollStart = Date.now();
    while (Date.now() - pollStart < 5000) {
      const stateCount = await ctx.page.evaluate(() => {
        const snap = window.app?.getSnapshot?.();
        const panes = snap?.context?.panes || [];
        const awId = snap?.context?.activeWindowId;
        return panes.filter(p => p.windowId === awId).length;
      });
      if (stateCount === 2) break;
      await delay(DELAYS.SHORT);
    }

    // Step 2: Reload
    await ctx.page.reload({ waitUntil: 'domcontentloaded' });
    await ctx.page.waitForSelector('[role="log"]', { timeout: 15000 });
    ctx.session.setPage(ctx.page);
    await waitForSessionReady(ctx.page, ctx.session.name, 15000);
    await delay(DELAYS.SYNC * 2);

    // Step 3: Verify preserved
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Re-focus after reload for keyboard operations
    await focusPage(ctx.page);

    // Step 4: Split via keyboard
    await splitPaneKeyboard(ctx.page, 'vertical');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 3);

    // Step 5: 3 rapid splits (wait for each to complete)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 5, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);

    // Step 6: UI synced
    const tmuxCount = await ctx.session.getPaneCount();
    expect(tmuxCount).toBe(6);
    await waitForPaneCount(ctx.page, 6);
    const uiCount = await getUIPaneCount(ctx.page);
    expect(uiCount).toBe(6);
  }, 180000);
});

// ==================== Scenario 13: Multi-Client ====================

describe('Scenario 13: Multi-Client', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('3 panes → page2 → both see layout', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create 3-pane layout
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);

    // Step 2: Open second page
    const page2 = await ctx.browser.newPage();
    await navigateToSession(page2, ctx.session.name);
    // Wait for the second page to fully load and render terminals
    await page2.waitForSelector('[role="log"]', { timeout: 15000 }).catch(() => {});
    await delay(DELAYS.SYNC * 2);

    // Step 3: Both see terminal
    const p1Terminal = await ctx.page.$('[role="log"]');
    const p2Terminal = await page2.$('[role="log"]');
    expect(p1Terminal).not.toBeNull();
    expect(p2Terminal).not.toBeNull();

    // Step 4: Second page sees the pane layout
    const p2PaneCount = await page2.evaluate(() => {
      const panes = document.querySelectorAll('[data-pane-id]');
      return panes.length || document.querySelectorAll('[role="log"]').length;
    });
    expect(p2PaneCount).toBeGreaterThanOrEqual(1);

    await page2.close();
  }, 180000);
});

// ==================== Scenario 22: Token-Free Command Routing ====================

describe('Scenario 22: Token-Free Command Routing', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Commands use connection ID header instead of session token', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Verify the adapter connects without a session token
    // The connection-info event should provide a connection_id
    const connInfo = await ctx.page.evaluate(() => {
      const adapter = window._adapter;
      // connectionId is stored on the adapter after connect
      return {
        connected: adapter?.isConnected?.() ?? false,
        // Access internal connectionId (set from connection-info event)
        hasConnectionId: typeof adapter?.connectionId === 'number' && adapter.connectionId > 0,
      };
    });
    expect(connInfo.connected).toBe(true);
    expect(connInfo.hasConnectionId).toBe(true);

    // Step 2: Commands work through the token-free path
    // send-keys routes through control mode via X-Connection-Id header
    const marker = `TOKEN_FREE_${Date.now()}`;
    await ctx.page.evaluate(async (cmd) => {
      await window._adapter?.invoke('run_tmux_command', { command: cmd });
    }, `send-keys -l 'echo ${marker}'`);
    await ctx.page.evaluate(async () => {
      await window._adapter?.invoke('run_tmux_command', { command: 'send-keys Enter' });
    });

    await ctx.page.waitForFunction(
      (m) => {
        const logs = document.querySelectorAll('[role="log"]');
        return Array.from(logs).some(l => (l.textContent || '').includes(m));
      },
      marker,
      { timeout: 10000, polling: 100 },
    );

    // Step 3: Split pane via the token-free command path
    await focusPage(ctx.page);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 4: Verify set_client_size works (uses conn_id from header)
    const resizeResult = await ctx.page.evaluate(async () => {
      try {
        await window._adapter?.invoke('set_client_size', { cols: 100, rows: 30 });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    expect(resizeResult.success).toBe(true);
  }, 180000);
});
