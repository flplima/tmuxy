/**
 * Session & Connectivity E2E Tests
 *
 * Session reconnect and multi-client scenarios.
 */

const { execSync } = require('child_process');
const {
  createTestContext,
  delay,
  focusPage,
  getUIPaneCount,
  waitForPaneCount,
  splitPaneKeyboard,
  navigateToSession,
  waitForSessionReady,
  verifyRoundTrip,
  waitForCondition,
  getBrowser,
  TmuxTestSession,
  assertLayoutInvariants,
  DELAYS,
  TMUXY_URL,
} = require('./helpers');
const { tmuxCmd } = require('./helpers/tmux-socket');

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
    // Wait for XState to reflect 2 panes
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot?.();
        const panes = snap?.context?.panes || [];
        const awId = snap?.context?.activeWindowId;
        return panes.filter((p) => p.windowId === awId).length === 2;
      },
      { timeout: 5000, polling: 100 },
    );

    // Step 2: Reload — wait for both DOM and XState hydration
    await ctx.page.reload({ waitUntil: 'domcontentloaded' });
    await ctx.page.waitForSelector('[role="log"]', { timeout: 15000 });
    // Wait for XState machine to hydrate with pane data
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot?.();
        return snap?.context?.panes?.length > 0;
      },
      { timeout: 15000, polling: 100 },
    );
    ctx.session.setPage(ctx.page);
    await waitForSessionReady(ctx.page, ctx.session.name, 15000);
    await delay(DELAYS.SYNC);

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

    // Step 7: Layout invariants on 6-pane layout
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 12 6-pane' });
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

    // Step 1: Verify the app is connected (XState machine is running)
    const appState = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      if (!snap) return null;
      return {
        connected: snap.context.connected ?? false,
        sessionName: snap.context.sessionName ?? null,
      };
    });
    expect(appState).not.toBeNull();
    expect(appState.connected).toBe(true);

    // Step 2: Split pane via keyboard
    await focusPage(ctx.page);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await delay(DELAYS.SYNC);
    await waitForPaneCount(ctx.page, 2, 10000);
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Step 3: Verify set_client_size works via HTTP POST with X-Connection-Id (no session token)
    const baseUrl = TMUXY_URL;
    const resizeResult = await ctx.page.evaluate(async (url) => {
      try {
        const res = await fetch(
          `${url}/commands?session=${encodeURIComponent(window.app?.getSnapshot()?.context?.sessionName || '')}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Connection-Id': '1' },
            body: JSON.stringify({ cmd: 'set_client_size', args: { cols: 100, rows: 30 } }),
          },
        );
        return { success: res.ok, status: res.status };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, baseUrl);
    expect(resizeResult.success).toBe(true);
  }, 180000);
});

// ==================== Scenario 24: Multi-Session Sidebar Tree (web) ====================

describe('Scenario 24: Multi-Session Sidebar Tree (web)', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The web build enumerates every session on its tmux socket (not just the
  // attached one) via the `serversActor` poll, groups them in the sidebar tree,
  // and can switch to a sibling session by activating its row. This exercises
  // that full chain on the real HTTP/SSE transport, which the unit + storybook
  // tests can't (they mock the poll and never reconnect the stream).
  test('sibling session appears in the tree and activating it switches the web client', async () => {
    if (ctx.skipIfNotReady()) return;

    // Bounding-rect probe: a tree row must be visually present, not just in the
    // DOM (per docs/TESTS.md — an element clipped to 0px is not "shown").
    const rowRect = (testId) =>
      ctx.page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top };
      }, testId);

    // Setup (NOT the feature under test): a second, vanilla tmux session on the
    // same socket. Created via external `new-session` BEFORE navigating — no
    // control-mode client is attached yet, so this is safe on tmux 3.5a (the
    // same reason the beforeEach warmup uses a raw new-session). It stands in
    // for "another session someone started on this server outside tmuxy".
    const siblingName = `tmuxy_sibling_${Date.now()}`;
    execSync(`${tmuxCmd()} new-session -d -s ${siblingName} -x 200 -y 50 -n foreignwin`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Capture the sibling's window/pane ids now (still no control mode attached,
    // so this external read is safe) to target its foreign rows by stable id.
    const siblingWinId = execSync(
      `${tmuxCmd()} list-windows -t ${siblingName} -F '#{window_id}'`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
    const siblingPaneId = execSync(
      `${tmuxCmd()} list-panes -t ${siblingName} -F '#{pane_id}'`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
    expect(siblingWinId).toMatch(/^@\d+$/);
    expect(siblingPaneId).toMatch(/^%\d+$/);

    try {
      // Connect the web client to the primary session (the server creates it via
      // `tmux -CC new-session`). The socket now hosts two sessions.
      await ctx.setupPage();
      const primaryName = ctx.session.name;

      // The sessions poll (~1.5s) enumerates both. Open the sidebar the way a
      // user does — the header toggle button (dispatches the same TOGGLE_SIDEBAR
      // as `prefix t`) — and wait for the grouped tree to render.
      await ctx.page.click('button[aria-label="Toggle sidebar"]');
      await ctx.page.waitForSelector('.sidebar-fixed', { timeout: 20000 });

      // Both session headers must render AND be visible. Two sessions on the
      // socket is what promotes the flat tab tree to the grouped session tree.
      await waitForCondition(
        ctx.page,
        async () => {
          const primary = await rowRect(`tree-session-${primaryName}`);
          const sibling = await rowRect(`tree-session-${siblingName}`);
          return !!primary && !!sibling && primary.h > 0 && sibling.h > 0;
        },
        20000,
        'both session headers to appear in the grouped tree',
      );

      const primaryHeader = await rowRect(`tree-session-${primaryName}`);
      const siblingHeader = await rowRect(`tree-session-${siblingName}`);
      expect(primaryHeader.w).toBeGreaterThan(20);
      expect(siblingHeader.w).toBeGreaterThan(20);

      // The sibling (inactive) session expands to read-only foreign rows — its
      // tab and pane, drawn from the poll snapshot, both visibly present.
      const foreignTab = await rowRect(`tree-foreign-tab-${siblingWinId}`);
      const foreignPane = await rowRect(`tree-foreign-pane-${siblingPaneId}`);
      expect(foreignTab).not.toBeNull();
      expect(foreignTab.h).toBeGreaterThan(0);
      expect(foreignPane).not.toBeNull();
      expect(foreignPane.h).toBeGreaterThan(0);

      // The active (primary) session still shows its LIVE rows from real state,
      // not the poll summary — its active window's tab is present.
      const primaryWinId = await ctx.page.evaluate(
        () => window.app?.getSnapshot()?.context?.activeWindowId,
      );
      const liveTab = await rowRect(`tree-tab-${primaryWinId}`);
      expect(liveTab).not.toBeNull();
      expect(liveTab.h).toBeGreaterThan(0);

      // Activate the sibling session by clicking its header — the real user path
      // for switching. On web this reconnects the SSE stream to that session.
      await ctx.page.click(`[data-testid="tree-session-${siblingName}"]`);
      await waitForCondition(
        ctx.page,
        async () =>
          ctx.page.evaluate(
            (name) => window.app?.getSnapshot()?.context?.sessionName === name,
            siblingName,
          ),
        15000,
        'web client to switch to the sibling session',
      );

      // The switch is real end-to-end: URL reflects it and the terminal for the
      // new session renders with a visible area (not a blank/disconnected view).
      const urlSession = await ctx.page.evaluate(
        () => new URL(window.location.href).searchParams.get('session'),
      );
      expect(urlSession).toBe(siblingName);
      await ctx.page.waitForSelector('[role="log"]', { timeout: 15000 });
      const termRect = await ctx.page.evaluate(() => {
        const el = document.querySelector('[role="log"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      expect(termRect).not.toBeNull();
      expect(termRect.w).toBeGreaterThan(50);
      expect(termRect.h).toBeGreaterThan(50);
    } finally {
      // Kill the sibling session (kill-session is safe to run externally per
      // docs/TMUX.md, even with control mode attached). The primary session is
      // cleaned up by afterEach.
      try {
        execSync(`${tmuxCmd()} kill-session -t ${siblingName}`, {
          encoding: 'utf-8',
          timeout: 10000,
        });
      } catch {
        // Already gone — fine.
      }
      await delay(500);
    }
  }, 180000);
});
