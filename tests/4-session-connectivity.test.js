/**
 * Session & Connectivity E2E Tests
 *
 * Session reconnect and multi-client scenarios.
 */

const os = require('os');
const {
  createTestContext,
  focusPage,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  getUIPaneCount,
  waitForPaneCount,
  splitPaneKeyboard,
  navigateToSession,
  waitForSessionReady,
  waitForCondition,
  assertLayoutInvariants,
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
    // The status line says where we are: the machine's own name, which the
    // server put in its greeting — not `localhost`, the address the page was
    // opened at, which would read the same from every machine.
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate((host) => {
          const el = document.querySelector('.tmux-status-bar .statusline-host');
          const r = el?.getBoundingClientRect();
          return !!el && el.textContent === host && r.width > 0 && r.height > 0;
        }, os.hostname()),
      5000,
      `the status line to name this machine (${os.hostname()})`,
    );
    await waitForSessionReady(ctx.page, ctx.session.name, 15000);

    // Step 3: Verify preserved
    await waitForCondition(
      ctx.page,
      async () => (await ctx.session.getPaneCount()) === 2,
      8000,
      'tmux to still report both panes after the reload',
    );
    expect(await ctx.session.getPaneCount()).toBe(2);

    // Re-focus after reload for keyboard operations
    await focusPage(ctx.page);

    // Step 4: Split via keyboard
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3);

    // Step 5: 3 rapid splits (wait for each to complete)
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 5, 10000);
    await splitPaneKeyboard(ctx.page, 'horizontal');

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

// ==================== Scenario 12b: Connection overlay and the reconnect notice ====================

describe('Scenario 12b: Connection overlay and the reconnect notice', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The old "Connecting to tmux…" page dumped the command log on screen and
  // unmounted the panes. Now a first load shows a placeholder + spinner, and
  // a dropped channel keeps the last frame in view, uncovered: after two
  // quiet seconds a notice in the snackbar corner says "Reconnecting…", and
  // it leaves on its own once the channel is back.
  test('reload shows no log → offline keeps the panes in view and after 2s says "Reconnecting…" in the corner → online clears it → shell still works', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);

    // Step 1: a fresh load never shows the log or the old status page.
    // Chrome keeps an already-open SSE stream alive under offline emulation,
    // so the drop below is delivered as the stream's own `error` event; keep a
    // handle on the streams this page opens.
    await page.addInitScript(() => {
      const streams = [];
      window.__eventSources = streams;
      const Native = window.EventSource;
      window.EventSource = function (url, init) {
        const es = new Native(url, init);
        streams.push(es);
        return es;
      };
      window.EventSource.prototype = Native.prototype;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPaneCount(page, 2, 15000);
    expect(await page.$('[data-testid="status-log"]')).toBeNull();
    expect(await page.$('.status-details-log')).toBeNull();
    expect(await page.$('[data-testid="loading-display"]')).toBeNull();

    // Step 2: the network goes away and the channel drops → the adapter's
    // reconnect loop keeps failing while offline. For two seconds nothing is
    // shown — a drop that heals at once is never seen — then a notice in the
    // snackbar corner, with the panes still in view and uncovered.
    await page.context().setOffline(true);
    const droppedAt = Date.now();
    await page.evaluate(() => {
      const es = window.__eventSources[window.__eventSources.length - 1];
      es.dispatchEvent(new Event('error'));
    });
    await waitForCondition(
      page,
      async () => (await page.$('[data-testid="reconnect-notice"]')) !== null,
      20000,
      'the reconnecting notice',
    );
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(1900);
    const shown = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="reconnect-notice"]');
      const container = document.querySelector('.pane-container');
      return {
        panes: document.querySelectorAll('.pane-layout-item').length,
        notice: notice.getBoundingClientRect().toJSON(),
        container: container.getBoundingClientRect().toJSON(),
        text: notice.textContent,
        role: notice.getAttribute('role'),
        spinner: Boolean(notice.querySelector('.connection-spinner')),
        overlay: document.querySelector('[data-testid="loading-display"]') !== null,
        scrim: document.querySelector('.connection-overlay-scrim') !== null,
        onTop:
          document
            .elementFromPoint(
              notice.getBoundingClientRect().left + 8,
              notice.getBoundingClientRect().top + 8,
            )
            ?.closest('[data-testid="reconnect-notice"]') !== null,
        paneUncovered:
          document
            .elementFromPoint(
              container.getBoundingClientRect().left + 20,
              container.getBoundingClientRect().bottom - 20,
            )
            ?.closest('.pane-layout-item') !== null,
      };
    });
    expect(shown.panes).toBe(2);
    expect(shown.text).toContain('Reconnecting');
    expect(shown.text).toContain('Retry now');
    expect(shown.role).toBe('status');
    expect(shown.spinner).toBe(true);
    expect(shown.overlay).toBe(false);
    expect(shown.scrim).toBe(false);
    expect(shown.onTop).toBe(true);
    expect(shown.paneUncovered).toBe(true);
    expect(shown.notice.width).toBeLessThan(shown.container.width / 2);
    expect(shown.notice.height).toBeLessThan(shown.container.height / 4);

    // Step 3: the network is back → the notice leaves on the first update
    // and the shell is live again.
    await page.context().setOffline(false);
    await waitForCondition(
      page,
      async () => (await page.$('[data-testid="reconnect-notice"]')) === null,
      45000,
      'the notice to clear after the channel recovers',
    );
    await focusPage(page);
    await typeInTerminal(page, 'echo OVERLAY_OK');
    await pressEnter(page);
    await waitForTerminalText(page, 'OVERLAY_OK', 15000);
  }, 150000);

  // Over a LAN the link drops often and briefly (sleep/wake, a Wi-Fi roam). The
  // backoff used to belong to the page rather than to the outage, so it only
  // climbed: a few drops in, every reconnect waited out the 30s cap, and
  // nothing told the sleeping retry that the network was back.
  test('six drops in a row → each reconnects within seconds of the network returning → "Retry now" retries on the spot [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    await page.addInitScript(() => {
      const streams = [];
      window.__eventSources = streams;
      const Native = window.EventSource;
      window.EventSource = function (url, init) {
        const es = new Native(url, init);
        streams.push(es);
        return es;
      };
      window.EventSource.prototype = Native.prototype;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPaneCount(page, 1, 15000);

    const noticeShown = async () => (await page.$('[data-testid="reconnect-notice"]')) !== null;
    const dropTheLink = async () => {
      await page.context().setOffline(true);
      await page.evaluate(() => {
        const es = window.__eventSources[window.__eventSources.length - 1];
        es.dispatchEvent(new Event('error'));
      });
      await waitForCondition(page, noticeShown, 20000, 'the reconnecting notice');
    };

    // Offline until two retries have failed (the backoff runs 1s, 2s, 4s…),
    // so the next scheduled one is seconds away: coming back within 4s is the
    // network-returned hint at work, not the schedule happening to be due.
    const waitForFailedRetries = async (count) => {
      const at = await page.evaluate(() => window.__eventSources.length);
      await waitForCondition(
        page,
        async () => (await page.evaluate(() => window.__eventSources.length)) >= at + count,
        20000,
        `${count} reconnect attempts to fail while offline`,
      );
    };

    for (let drop = 1; drop <= 6; drop++) {
      await dropTheLink();
      await waitForFailedRetries(2);
      const backAt = Date.now();
      await page.context().setOffline(false);
      await waitForCondition(
        page,
        async () => !(await noticeShown()),
        15000,
        `drop ${drop}: the notice to clear`,
      );
      expect(Date.now() - backAt).toBeLessThan(4000);
    }

    // The button is the user's own way to say "now": visible on the notice,
    // and pressing it opens a stream immediately rather than at the next tick.
    await dropTheLink();
    await waitForFailedRetries(2);
    const retryNow = page.getByRole('button', { name: 'Retry now' });
    const box = await retryNow.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const before = await page.evaluate(() => window.__eventSources.length);
    await retryNow.click();
    await waitForCondition(
      page,
      async () => (await page.evaluate(() => window.__eventSources.length)) > before,
      1000,
      'a new stream right after "Retry now"',
    );

    await page.context().setOffline(false);
    await waitForCondition(page, async () => !(await noticeShown()), 15000, 'the notice to clear');
    await focusPage(page);
    await typeInTerminal(page, 'echo RECONNECT_OK');
    await pressEnter(page);
    await waitForTerminalText(page, 'RECONNECT_OK', 15000);
  }, 240000);
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
    // (Step 4 then waits for its three panes, which is what "loaded" means.)
    await page2.waitForSelector('[role="log"]', { timeout: 15000 }).catch(() => {});

    // Step 3: Both see terminal
    const p1Terminal = await ctx.page.$('[role="log"]');
    const p2Terminal = await page2.$('[role="log"]');
    expect(p1Terminal).not.toBeNull();
    expect(p2Terminal).not.toBeNull();

    // Step 4: Second page must see the SAME 3-pane layout, not merely "a
    // terminal" (the old >= 1 assertion passed with the layout entirely
    // unsynced).
    const uniquePaneCount = () => {
      const ids = new Set();
      for (const el of document.querySelectorAll('[data-pane-id]')) {
        ids.add(el.getAttribute('data-pane-id'));
      }
      return ids.size;
    };
    await page2
      .waitForFunction(`(${uniquePaneCount.toString()})() >= 3`, { timeout: 15000 })
      .catch(() => {});
    // Unique ids: each pane emits data-pane-id on both its wrapper and its
    // inner TerminalPane, so raw element counts are 2x the pane count.
    const p2PaneCount = await page2.evaluate(`(${uniquePaneCount.toString()})()`);
    expect(p2PaneCount).toBe(3);

    // Step 5: Content typed on page 1 must propagate to page 2 — the actual
    // multi-client promise. Opening page2 blurred page 1 (APP_BLUR disables
    // its keyboard actor), so bring page 1 back to front before typing, and
    // confirm the token rendered on page 1 first so a typing failure is
    // distinguishable from a propagation failure.
    const MC_TOKEN = `MULTI_${Date.now()}`;
    await ctx.page.bringToFront();
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${MC_TOKEN}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, MC_TOKEN);
    // Bring page 2 forward before asserting: the adapter applies state
    // updates in requestAnimationFrame batches, and browsers throttle rAF in
    // background pages — a backgrounded client holds the data but doesn't
    // paint it until it becomes visible. What we assert is propagation:
    // page 2's client received and renders the content typed on page 1.
    await page2.bringToFront();
    // Playwright signature is (fn, ARG, options) — arg before options.
    await page2.waitForFunction(
      (token) => (document.body.textContent || '').includes(token),
      MC_TOKEN,
      { timeout: 15000 },
    );

    await page2.close();
  }, 180000);
});
