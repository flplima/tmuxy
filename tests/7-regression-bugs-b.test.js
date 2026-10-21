/**
 * Regression Tests for Production Bugs (Part B)
 *
 * Pane-group tab keystroke routing, pane header title announcements,
 * pane group exit promotion, and idle tab-switch convergence.
 */

const {
  createTestContext,
  delay,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  clickPaneGroupAdd,
  getGroupTabInfo,
  waitForGroupTabs,
  waitForCondition,
  waitForSettled,
  runCommand,
  DELAYS,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

// ==================== Scenario: keystrokes route to clicked pane-group tab ====================

describe('Scenario: keystrokes route to the clicked pane-group tab', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a pane header shows a new title the moment the program announces it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const paneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(paneId).not.toBeNull();

    const title = `TITLE_${Date.now()}`;
    // OSC 2, the way any program announces what it is now doing. Nothing else
    // in this test touches tmux: the point is that the header reacts to the
    // pane's own output rather than to a poll.
    await typeInTerminal(ctx.page, `printf '\\033]2;${title}\\007'`);
    await pressEnter(ctx.page);

    // 5s is deliberately well under the 15s idle heartbeat that used to be the
    // only thing bringing a new pane_title back — a pass here cannot be the
    // poll arriving.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate((want) => {
          const header = document.querySelector('.pane-tab-title');
          return !!header && (header.textContent || '').includes(want);
        }, title),
      5000,
      'the pane header to show the announced title',
    );

    // And it is on screen, not merely in the DOM.
    const box = await ctx.page.evaluate(() => {
      const header = document.querySelector('.pane-tab-title');
      if (!header) return null;
      const r = header.getBoundingClientRect();
      return { w: r.width, h: r.height, top: r.top };
    });
    expect(box).not.toBeNull();
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
  }, 120000);

  test('typing exit in a pane group closes only that member and promotes the next one', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // ALPHA is the anchor, visible to start with.
    const alphaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(alphaId).not.toBeNull();
    await runCommand(ctx.page, 'echo ALPHA_MARK', 'ALPHA_MARK');

    // Group it: BETA is created and swapped into the visible slot.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId)) !==
        alphaId,
      8000,
      'the new member to take the keyboard',
    );

    const betaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(betaId).not.toBe(alphaId);
    await runCommand(ctx.page, 'echo BETA_MARK', 'BETA_MARK');

    // The real user path, and the one every other close path skipped: end the
    // program yourself. `exit` is not the close button, not kill-pane, and not
    // the CLI — tmux removes the pane on its own, taking the visible slot with
    // it, and the hidden sibling was left with no visible member. The whole
    // group vanished: one `exit` closed tabs the user never asked to close.
    await typeInTerminal(ctx.page, 'exit');
    await pressEnter(ctx.page);

    // One member left, so the group dissolves into an ordinary pane — but the
    // SURVIVOR has to still be there, showing its own content.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate((gone) => {
          const panes = window.app?.getSnapshot()?.context?.panes ?? [];
          return panes.length > 0 && !panes.some((p) => p.tmuxId === gone);
        }, betaId),
      20000,
      'the exited pane to go and the group to survive it',
    );

    // ALPHA is back in the visible slot with the content it had — proving a
    // promotion happened rather than the group being torn down and a fresh
    // shell appearing.
    await waitForTerminalText(ctx.page, 'ALPHA_MARK', 20000);

    const survivors = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.panes?.map((p) => p.tmuxId) ?? [],
    );
    expect(survivors).toContain(alphaId);
    expect(survivors).not.toContain(betaId);
  }, 120000);

  test('Typing immediately after a pane-group tab click hits the clicked pane, not the previously-visible one', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Record the original (ALPHA) pane id. ALPHA is visible at this point.
    const alphaId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(alphaId).not.toBeNull();

    // Leave a fingerprint marker in ALPHA so we can recognize it later.
    await runCommand(ctx.page, 'echo ALPHA_HOME', 'ALPHA_HOME');

    // Add to group — creates BETA and swaps it into the visible slot.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId)) !==
        alphaId,
      8000,
      'the new member to take the keyboard',
    );

    const betaId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(betaId).not.toBeNull();
    expect(betaId).not.toBe(alphaId);

    // Fingerprint marker for BETA so the two panes have distinct content.
    await runCommand(ctx.page, 'echo BETA_HOME', 'BETA_HOME');

    // Find ALPHA's (currently inactive) tab.
    const tabs = await getGroupTabInfo(ctx.page);
    const alphaTabIdx = tabs.findIndex((t) => !t.active);
    expect(alphaTabIdx).toBeGreaterThanOrEqual(0);

    // Click ALPHA's tab, then send keystrokes IMMEDIATELY — no re-click on
    // the terminal, no settle delay. This is the user flow that surfaces
    // the bug: tab click + impatient typing. typeInTerminal would mask the
    // bug because it re-clicks the active pane's terminal element, which
    // would re-route focus to whichever pane the UI currently considers
    // active (BETA pre-fix, ALPHA post-fix).
    // The marker's FIRST character is load-bearing: the keyboardActor reads its
    // send-keys target from the machine's live activePaneId snapshot, which the
    // tab click updates synchronously — so even a keystroke fired in the same
    // tick must route to ALPHA. Before that fix the actor used its cached
    // closure, refreshed a task later, and the first character landed in BETA
    // (see keyboardActor active-pane-target unit test).
    const marker = `ALPHAKEY${Date.now()}`;
    await ctx.page.evaluate((idx) => {
      const tabEls = document.querySelectorAll('.pane-tabs .pane-tab');
      if (tabEls[idx]) tabEls[idx].click();
    }, alphaTabIdx);

    // Fire keystrokes via the page-level keyboard so they go through the
    // same `window.addEventListener('keydown')` path the keyboardActor uses.
    // The keyboardActor's send-keys target decides where they land; pre-fix the
    // first one would carry BETA's id and split the marker across two panes.
    for (const ch of marker) {
      await ctx.page.keyboard.type(ch);
    }
    await ctx.page.keyboard.press('Enter');

    // Wait for the marker to appear in the visible pane (ALPHA after the
    // optimistic swap completes). If routing is broken, the marker lands
    // in BETA and never shows up here — the wait times out and the
    // expectation below fails, which is the regression we want to catch.
    // 20s (not 10s): the keystroke round-trip (type → tmux → SSE → DOM) can
    // exceed 10s under CI-runner load, which flaked this test; a real routing
    // bug still never surfaces the marker, so the longer wait only tolerates
    // latency, it doesn't weaken the assertion.
    await waitForTerminalText(ctx.page, marker, 20000);

    // The visible pane is ALPHA; assert ALPHA's fingerprint is also present
    // so we're not just matching against any pane that happens to render.
    const alphaDom = await ctx.page.evaluate(() => {
      const log = document.querySelector('.pane-active [role="log"]');
      return (log?.textContent || '').replace(/\s+/g, ' ');
    });
    expect(alphaDom).toContain('ALPHA_HOME');
    expect(alphaDom).toContain(marker);

    // Switch to BETA's tab and confirm its DOM does NOT contain the marker.
    // Pre-fix, the marker would be in BETA (the previously-visible pane);
    // post-fix it must stay confined to ALPHA.
    const tabsAfter = await getGroupTabInfo(ctx.page);
    const betaTabIdx = tabsAfter.findIndex((t) => !t.active);
    expect(betaTabIdx).toBeGreaterThanOrEqual(0);
    await ctx.page.evaluate((idx) => {
      const tabEls = document.querySelectorAll('.pane-tabs .pane-tab');
      if (tabEls[idx]) tabEls[idx].click();
    }, betaTabIdx);

    // Wait for BETA to be the visible pane via its fingerprint, then assert
    // the marker isn't there. waitForCondition guards against the swap
    // racing with the DOM read.
    await waitForCondition(
      ctx.page,
      async () => {
        const txt = await ctx.page.evaluate(() => {
          const log = document.querySelector('.pane-active [role="log"]');
          return (log?.textContent || '').replace(/\s+/g, ' ');
        });
        return txt.includes('BETA_HOME');
      },
      20000,
      'BETA pane to become visible',
    );

    const betaDom = await ctx.page.evaluate(() => {
      const log = document.querySelector('.pane-active [role="log"]');
      return (log?.textContent || '').replace(/\s+/g, ' ');
    });
    expect(betaDom).toContain('BETA_HOME');
    expect(betaDom).not.toContain(marker);
  });
});

// ==================== Scenario: Tab switch converges on idle terminal ====================

describe('Scenario: Tab switch converges to tmux truth on idle terminal', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // Ground truth straight from tmux: the window tmux itself considers active.
  const tmuxActiveWindow = () => {
    const out = tmuxExec(`list-windows -t ${ctx.session.name} -F '#{window_id}|#{window_active}'`, {
      timeout: 5000,
    });
    const active = out
      .split('\n')
      .map((l) => l.split('|'))
      .find(([, a]) => a === '1');
    return active ? active[0] : null;
  };

  const clickAddTab = async () => {
    await ctx.page.click('.tab-add');
  };
  const clickTab = async (idx) => {
    const tabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    await tabs[idx].click();
  };
  const tabCount = async () => (await ctx.page.$$('.tab-name:not(.tab-add)')).length;

  // Assert the UI's rendered active tab agrees with tmux reality. `activeWindowId`
  // drives which panes render, so any divergence means the user sees the wrong tab.
  const assertConverged = (label) => async () => {
    let state;
    let truth;
    await waitForCondition(
      ctx.page,
      async () => {
        state = await ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          const tabs = (c?.windows || []).filter((w) => w.windowType === 'tab');
          const flagged = tabs.filter((w) => w.active).map((w) => w.id);
          const activePaneWindow = (c?.panes || []).find(
            (p) => p.tmuxId === c.activePaneId,
          )?.windowId;
          return { activeWindowId: c?.activeWindowId, flagged, activePaneWindow };
        });
        truth = tmuxActiveWindow();
        return (
          state?.activeWindowId === truth &&
          JSON.stringify(state?.flagged) === JSON.stringify([truth]) &&
          state?.activePaneWindow === truth
        );
      },
      15000,
      () => `${label} to converge (ui active: ${state?.activeWindowId}, tmux truth: ${truth})`,
    );
    expect(`${label}: ${state.activeWindowId}`).toBe(`${label}: ${truth}`);
    expect(`${label}: ${JSON.stringify(state.flagged)}`).toBe(
      `${label}: ${JSON.stringify([truth])}`,
    );
    expect(`${label}: ${state.activePaneWindow}`).toBe(`${label}: ${truth}`);
  };

  test('Creating tabs then switching keeps the rendered tab in sync with tmux [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // BUG: the optimistic `activeWindowId` flip on tab switch was only ever
    // reconciled by a *future* server snapshot. Creating tabs (the splitw+breakp
    // new-window path) leaves the UI's window indices briefly lagging tmux's, so
    // a click can send `select-window -t <staleIndex>` that no-ops in tmux
    // (already on that index) — no state change, no snapshot. The optimistic flip
    // to the *predicted* window then stuck forever: the UI rendered the wrong
    // tab's panes while tmux and the per-window active flags pointed elsewhere.
    // The fix schedules a timer-driven reconciliation that snaps `activeWindowId`
    // back to server truth once the optimistic grace elapses, even with no
    // follow-up snapshot.

    // Build 4 tabs via the "+" button (real user path → new-window).
    for (let i = 0; i < 3; i++) {
      await clickAddTab();
      await waitForWindowCount(ctx.page, i + 2, 15000);
    }
    await assertConverged('after create')();

    // The terminal is idle (no command output), so nothing but the fix's timer
    // can reconcile a mispredicted switch. Switch through every tab, then rapid
    // first<->last — the patterns that surfaced the divergence in the wild.
    // `waitForSettled` holds while a switch is still a pending op, so it
    // returns only once that timer has given its verdict on every one.
    const n = await tabCount();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        await clickTab(i);
        await delay(150);
      }
      await waitForSettled(ctx.page);
      await assertConverged(`round ${round} switch-all`)();

      for (let k = 0; k < 3; k++) {
        await clickTab(0);
        await delay(80);
        await clickTab(n - 1);
        await delay(80);
      }
      await waitForSettled(ctx.page);
      await assertConverged(`round ${round} rapid-switch`)();
    }
  }, 240000);
});
