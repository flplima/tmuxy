/**
 * Regression Tests for Production Bugs
 *
 * Tests for bugs found in production that E2E tests previously missed.
 * Each scenario targets a specific gap in test coverage.
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
  runCommand,
  tmuxCommandKeyboard,
  DELAYS,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

// ==================== Scenario: Copy mode reveals terminal history ====================

describe('Scenario: Copy mode reveals terminal history above visible content', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // Reactive (server-initiated) copy-mode entry — e.g. a CLI
  // `tmuxy run copy-mode -t %X` or any custom binding that flips tmux's
  // `in_mode` without going through the frontend's SEND_TMUX_COMMAND
  // intercept — used to fetch only `height + 200` history lines. Anything
  // older than that 200-line slab was invisible on scroll. Fix 1 unifies
  // this path with the user-initiated one (full live history). The
  // user-initiated paths — the wheel and `<prefix>[` — are covered where
  // those gestures live, in 1-input Scenarios 7 and 9.
  test('Copy mode entered server-side fetches the entire history, not a 200-line slab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate ~500 lines — well past the old `height + 200` cap so the
    // pre-Fix-1 behavior would silently truncate the top ~270 lines.
    await runCommand(
      ctx.page,
      'for i in $(seq -w 1 500); do echo "REACTIVE_$i"; done',
      'REACTIVE_500',
    );

    const paneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(paneId).not.toBeNull();

    // Enter copy mode WITHOUT going through the frontend keybinding path
    // so the reactive detector in TMUX_STATE_UPDATE is what creates the
    // copyModeStates entry and fires the scrollback fetch. `runCommand` on
    // the test session routes `copy-mode` through `tmuxy run` (run-shell)
    // because it isn't in the safe-externally read-only list.
    ctx.session.runCommand(`copy-mode -t ${paneId}`);

    // Wait for client copy mode + full scrollback coverage.
    // Playwright's waitForFunction signature is `(fn, arg, options)` — getting
    // the order wrong (passing options where arg should be) silently feeds the
    // predicate an options object instead of the pane id, which never matches.
    await ctx.page.waitForFunction(
      (id) => {
        const snap = window.app?.getSnapshot();
        const cs = snap?.context?.copyModeStates?.[id];
        if (!cs) return false;
        if (cs.historySize < 300) return false;
        if (cs.loading) return false;
        if (cs.loadedRanges.length === 0) return false;
        const first = cs.loadedRanges[0];
        const last = cs.loadedRanges[cs.loadedRanges.length - 1];
        return first[0] <= 0 && last[1] >= cs.totalLines - 1;
      },
      paneId,
      { timeout: 30000, polling: 100 },
    );

    // Drive the viewport to the top via the state machine. The oldest
    // REACTIVE_001 marker MUST appear in the rendered <pre>; pre-Fix-1 it
    // would render as PLACEHOLDER (post-Fix-3) or as an empty line
    // (pre-Fix-3), with no actual content because the fetch never asked
    // for those rows.
    await ctx.page.evaluate(
      ({ id }) => {
        window.app?.send({ type: 'COPY_MODE_SCROLL', paneId: id, scrollTop: 0 });
      },
      { id: paneId },
    );
    const topText = () =>
      ctx.page.evaluate(() => {
        const sb = document.querySelector('[data-copy-mode="true"]');
        if (!sb) return null;
        return Array.from(sb.querySelectorAll('.terminal-line'))
          .slice(0, 40)
          .map((el) => el.textContent || '')
          .join('\n');
      });
    await waitForCondition(
      ctx.page,
      async () => /REACTIVE_0*1\b/.test((await topText()) || ''),
      10000,
      'the oldest history line to be drawn at the top',
    );
    // The newer end-of-history markers must NOT be at the top after
    // scrolling to row 0 — that would mean the lines Map is misaligned.
    expect(await topText()).not.toContain('REACTIVE_500');
  });
});

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

// ==================== Scenario: rapid pane-group tab switches don't blink ====================

describe('Scenario: rapid pane-group tab switches do not blink previously-visible content', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Clicking three pane-group tabs in rapid succession never flashes a non-target pane in the visible slot [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Build a 3-pane group with distinct content per pane so we can fingerprint
    // which pane is in the visible window slot at every captured frame.
    await runCommand(ctx.page, 'echo ALPHA_TAB', 'ALPHA_TAB');
    const alphaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(alphaId).not.toBeNull();

    const activePane = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) !== alphaId,
      8000,
      'the second member to take the keyboard',
    );
    await runCommand(ctx.page, 'echo BETA_TAB', 'BETA_TAB');
    const betaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(betaId).not.toBeNull();
    expect(betaId).not.toBe(alphaId);

    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    await waitForCondition(
      ctx.page,
      async () => ![alphaId, betaId].includes(await activePane()),
      8000,
      'the third member to take the keyboard',
    );
    await runCommand(ctx.page, 'echo GAMMA_TAB', 'GAMMA_TAB');
    const gammaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(gammaId).not.toBeNull();
    expect(gammaId).not.toBe(alphaId);
    expect(gammaId).not.toBe(betaId);

    // GAMMA is the visible peer right now (it was just added). Wire up the
    // RAF + MutationObserver sampler BEFORE the rapid clicks so we can't
    // miss any intermediate React commit. Sample what's in the .pane-active
    // [role="log"] each frame for ~700 ms (longer than the 500 ms freeze).
    await ctx.page.evaluate(
      ({ alphaMark, betaMark, gammaMark }) => {
        window.__rapidSwitchSamples = [];
        window.__rapidSwitchMutations = [];
        window.__rapidSwitchT0 = null;

        function snapshotVisible() {
          const items = document.querySelectorAll('.pane-layout-item');
          const out = [];
          for (const it of items) {
            const log = it.querySelector('[role="log"]');
            const txt = (log?.textContent || '').replace(/\s+/g, ' ');
            const r = it.getBoundingClientRect();
            out.push({
              id: it.getAttribute('data-pane-id'),
              w: Math.round(r.width),
              h: Math.round(r.height),
              hasAlpha: txt.includes(alphaMark),
              hasBeta: txt.includes(betaMark),
              hasGamma: txt.includes(gammaMark),
            });
          }
          return out;
        }
        window.__snapshotVisible = snapshotVisible;

        const observer = new MutationObserver(() => {
          if (window.__rapidSwitchT0 === null) return;
          const dt = Math.round(performance.now() - window.__rapidSwitchT0);
          window.__rapidSwitchMutations.push({ dt, panes: snapshotVisible() });
        });
        const root = document.querySelector('.pane-layout') || document.body;
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        window.__rapidSwitchObserver = observer;

        function sample() {
          if (window.__rapidSwitchT0 === null) {
            requestAnimationFrame(sample);
            return;
          }
          const dt = Math.round(performance.now() - window.__rapidSwitchT0);
          window.__rapidSwitchSamples.push({ dt, panes: snapshotVisible() });
          if (dt < 700) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      },
      { alphaMark: 'ALPHA_TAB', betaMark: 'BETA_TAB', gammaMark: 'GAMMA_TAB' },
    );

    // Rapid click sequence: GAMMA (visible) → ALPHA → BETA, in the same
    // synchronous evaluate so every click lands within ~10 ms — well inside
    // the 500 ms freeze window that hides nvim's mid-swap redraw flicker.
    // Pre-fix, the previously-visible peer (GAMMA) would briefly flash back
    // into the visible slot when the override from click#1 was replaced by
    // click#2's override (which only protected BETA and ALPHA, not GAMMA).
    const tabIndices = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.pane-tabs .pane-tab');
      return Array.from(tabs).map((t) => ({
        active:
          t.classList.contains('pane-tab-active') || t.classList.contains('pane-tab-selected'),
      }));
    });
    // ALPHA is the first non-active tab; BETA is the second.
    const inactiveIdxs = tabIndices.map((t, i) => (t.active ? -1 : i)).filter((i) => i >= 0);
    expect(inactiveIdxs.length).toBeGreaterThanOrEqual(2);

    await ctx.page.evaluate((idxs) => {
      window.__rapidSwitchT0 = performance.now();
      const tabs = document.querySelectorAll('.pane-tabs .pane-tab');
      // Two rapid clicks, fully synchronous so the second lands inside the
      // 500 ms freeze window opened by the first.
      if (tabs[idxs[0]]) tabs[idxs[0]].click();
      if (tabs[idxs[1]]) tabs[idxs[1]].click();
    }, inactiveIdxs);

    // Let watchers finish the ~700 ms sample window.
    await delay(900);

    const { samples, mutations } = await ctx.page.evaluate(() => ({
      samples: window.__rapidSwitchSamples,
      mutations: window.__rapidSwitchMutations,
    }));

    // Sanity: watchers fired.
    expect(samples.length).toBeGreaterThan(3);
    expect(mutations.length).toBeGreaterThan(0);

    // Each captured frame must show AT MOST ONE pane in the visible window
    // that contains a marker. Multiple markers in the visible slot at once
    // indicates a render bug. Pre-fix, GAMMA's content could leak through
    // when its protection got stripped by the replaced override.
    const multiMarkerFrames = [...samples, ...mutations].filter((s) => {
      const present = s.panes.filter(
        (p) => (p.hasAlpha ? 1 : 0) + (p.hasBeta ? 1 : 0) + (p.hasGamma ? 1 : 0) > 0,
      );
      // count panes that have ANY marker — there should never be more than
      // one such pane visible at once, since only one pane occupies the
      // active window's group slot.
      return present.length > 1;
    });
    if (multiMarkerFrames.length > 0) {
      console.warn('multi-marker frames:', JSON.stringify(multiMarkerFrames.slice(0, 3), null, 2));
    }
    expect(multiMarkerFrames).toEqual([]);

    // After the freeze settles, the visible pane MUST be the LAST clicked
    // tab (BETA, the second click in the rapid sequence).
    await waitForCondition(
      ctx.page,
      async () => {
        const txt = await ctx.page.evaluate(() => {
          const log = document.querySelector('.pane-active [role="log"]');
          return (log?.textContent || '').replace(/\s+/g, ' ');
        });
        return txt.includes('BETA_TAB');
      },
      10000,
      'BETA to be the final visible pane after rapid swap settles',
    );

    // Once BETA is visible and the freeze has cleared, NO further frame
    // should leak ALPHA or GAMMA into the visible slot — the freeze union-
    // pins every involved pane until each override expires, but post-settle
    // the visible content must be stable.
    await delay(200);
    const stableTxt = await ctx.page.evaluate(() => {
      const log = document.querySelector('.pane-active [role="log"]');
      return (log?.textContent || '').replace(/\s+/g, ' ');
    });
    expect(stableTxt).toContain('BETA_TAB');
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
    const state = await ctx.page.evaluate(() => {
      const c = window.app?.getSnapshot()?.context;
      const tabs = (c?.windows || []).filter((w) => w.windowType === 'tab');
      const flagged = tabs.filter((w) => w.active).map((w) => w.id);
      const activePaneWindow = (c?.panes || []).find((p) => p.tmuxId === c.activePaneId)?.windowId;
      return { activeWindowId: c?.activeWindowId, flagged, activePaneWindow };
    });
    const truth = tmuxActiveWindow();
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
    const n = await tabCount();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        await clickTab(i);
        await delay(150);
      }
      await delay(DELAYS.SYNC);
      await assertConverged(`round ${round} switch-all`)();

      for (let k = 0; k < 3; k++) {
        await clickTab(0);
        await delay(80);
        await clickTab(n - 1);
        await delay(80);
      }
      await delay(DELAYS.SYNC);
      await assertConverged(`round ${round} rapid-switch`)();
    }
  }, 240000);
});

// ==================== Scenario: commands act on the tab the user sees ====================

/**
 * Two shipped bugs shared one cause: nothing forced tmux's current window to be
 * the tab on screen, so a command that named no window ran wherever tmux
 * happened to be — usually the first tab.
 *
 * The existing coverage could not see it. Every other suite creates tabs with a
 * helper that POSTs `new-window` straight to the server, and reaches the prefix
 * through `sendPrefixCommand`, which clicks the active pane first. Both put tmux
 * back in step with the UI before the command under test ever runs. A user who
 * clicks a TAB and then presses a prefix key does neither, so this scenario
 * clicks the "+" button, clicks a tab, and drives the prefix with no pane click
 * in between.
 */
describe('Scenario: an unpinned command lands in the tab on screen', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('split and sidebar both act on the visible tab, not on tmux’s current window', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // Prefix without the focus click the shared helper performs — that click
    // is what has been hiding this bug.
    const prefixNoPaneClick = async (key, shift = false) => {
      await page.keyboard.down('Control');
      await delay(60);
      await page.keyboard.press('a');
      await delay(60);
      await page.keyboard.up('Control');
      await waitForCondition(
        page,
        () => page.evaluate(() => window.app?.getSnapshot()?.context?.prefixActive === true),
        5000,
        'prefix mode',
      );
      if (shift) await page.keyboard.down('Shift');
      await page.keyboard.press(key);
      if (shift) await page.keyboard.up('Shift');
      await delay(DELAYS.LONG);
    };

    const panesByWindow = async () => {
      const raw = String(
        await ctx.session.query("list-panes -a -F '#{window_id}\t#{pane_id}'"),
      ).trim();
      const map = {};
      for (const line of raw.split('\n')) {
        const [win, pane] = line.split('\t');
        if (!win) continue;
        (map[win] = map[win] || []).push(pane);
      }
      return map;
    };
    const visibleTab = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);

    // Two more tabs, created the way a user does: the "+" button.
    const startCount = (await page.$$('.tab-list .tab-name')).length;
    await page.click('.tab-add');
    await waitForWindowCount(page, startCount + 1);
    await page.click('.tab-add');
    await waitForWindowCount(page, startCount + 2);

    // Land on the LAST tab by clicking it in the strip. No pane is clicked, so
    // nothing re-points tmux at this window behind the scenes.
    // A locator, not a handle: the strip re-renders as the new tab's name
    // settles, and a handle taken a moment earlier can point at a replaced node.
    await page.locator('.tab-list .tab-name').last().click();
    await delay(DELAYS.SYNC);
    const target = await visibleTab();
    expect(target).toMatch(/^@\d+$/);

    const before = await panesByWindow();
    const firstTab = await page.evaluate(
      () =>
        (window.app?.getSnapshot()?.context?.windows || [])
          .filter((w) => w.windowType === 'tab')
          .sort((a, b) => a.index - b.index)[0]?.id,
    );

    // 1. The split belongs to the tab on screen.
    await prefixNoPaneClick('5', true);
    await waitForCondition(
      page,
      async () => ((await panesByWindow())[target] || []).length === before[target].length + 1,
      8000,
      'the split to land in the visible tab',
    );
    const afterSplit = await panesByWindow();
    expect(afterSplit[firstTab].length).toBe(before[firstTab].length);

    // 2. The sidebar becomes its own window, and leaves no pane behind in any
    // tab. On the desktop transport the break-pane used to fail outright and
    // the tree stayed put as an ordinary pane.
    await prefixNoPaneClick('t');
    await waitForCondition(
      page,
      async () => {
        const names = String(await ctx.session.query("list-windows -a -F '#{window_name}'"));
        return names.includes('__sidebar-left');
      },
      15000,
      'the sidebar to become its own window',
    );
    const afterSidebar = await panesByWindow();
    expect(afterSidebar[target].length).toBe(afterSplit[target].length);
    expect(afterSidebar[firstTab].length).toBe(before[firstTab].length);
  }, 120000);
});

// ==================== Scenario: a rejected tmux command is reported ====================
//
// Every command reaches tmux over the control-mode connection and resolves
// to nothing, so tmux's `%error` is the only word the user gets when a split,
// a kill or a prompt command did nothing. The monitor attributes it to the
// command and the app shows it as a snackbar in the top-right corner — not on
// the status line, which is for status.

describe('Scenario: a rejected tmux command is reported in the snackbar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('tmux’s message appears top-right, off the status line, and the close button dismisses it [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    const message = "can't find window: @999";

    await tmuxCommandKeyboard(page, 'kill-window -t @999');

    const findItem = async () => {
      for (const item of await page.$$('[data-testid="snackbar-item"]')) {
        if ((await item.evaluate((el) => el.textContent)).includes(message)) return item;
      }
      return null;
    };
    await waitForCondition(page, async () => (await findItem()) !== null, 8000, 'the snackbar');
    const item = await findItem();

    // On screen, in the top-right corner of the chrome, under the tab bar.
    const box = await item.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.x).toBeGreaterThan(viewport.width / 2);
    expect(box.y).toBeLessThan(viewport.height / 4);

    // The status line stays clear of it.
    const statusText = await page.$eval('[data-testid="tmux-status-bar"]', (el) => el.textContent);
    expect(statusText).not.toContain(message);

    // The close button dismisses this entry.
    const close = await item.$('button[aria-label="Dismiss notification"]');
    await close.click();
    await waitForCondition(
      page,
      async () => (await findItem()) === null,
      5000,
      'the snackbar to close',
    );
  }, 60000);
});
