/**
 * Regression Tests for Production Bugs
 *
 * Tests for bugs found in production that E2E tests previously missed.
 * Each scenario targets a specific gap in test coverage.
 */

const {
  createTestContext,
  delay,
  clickPaneGroupAdd,
  waitForGroupTabs,
  waitForCondition,
  runCommand,
} = require('./helpers');

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
        window.__rapidSwitchDone = false;
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
          else window.__rapidSwitchDone = true;
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

    // The sampler covers 700 ms of frames from the clicks, however long a
    // slow machine takes to draw them.
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => window.__rapidSwitchDone === true),
      10000,
      'the sampler to cover its window',
    );

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
