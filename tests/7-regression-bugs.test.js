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
  createWindowKeyboard,
  clickPaneGroupAdd,
  getGroupTabInfo,
  waitForGroupTabs,
  waitForCondition,
  runCommand,
  focusPage,
  tmuxCommandKeyboard,
  enterCopyModeAndWait,
  getCopyModeState,
  DELAYS,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

// ==================== Scenario: Tab numbering is sequential ====================

describe('Scenario: Tab numbering is sequential', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Tab labels show sequential indices regardless of internal tmux window IDs', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create a pane group (which uses hidden tmux windows)
    await clickPaneGroupAdd(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 2: Create a new visible window
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await delay(DELAYS.MEDIUM);

    // Step 3: Read tab labels from the UI
    const tabLabels = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      return Array.from(tabs).map((t) => t.textContent.trim());
    });

    // Tabs should be "1:name" and "2:name" (sequential), not "1:name" and "5:name"
    expect(tabLabels.length).toBe(2);
    expect(tabLabels[0]).toMatch(/^1:/);
    expect(tabLabels[1]).toMatch(/^2:/);
  });
});

// ==================== Scenario: Pane group tab label updates on process exit ====================

describe('Scenario: Pane group tab label updates on process exit', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Group tab label updates when a program exits', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create a pane group
    await clickPaneGroupAdd(ctx.page);
    await delay(DELAYS.SYNC);

    // Step 2: Start a long-running program
    await typeInTerminal(ctx.page, 'sleep 30');
    await pressEnter(ctx.page);

    // Step 3: Wait for the tab label to show "sleep" (metadata sync may take up to 2s)
    await waitForCondition(
      ctx.page,
      async () => {
        const info = await getGroupTabInfo(ctx.page);
        const tab = info.find((t) => t.active);
        return tab && tab.title.includes('sleep');
      },
      5000,
      'group tab to show "sleep"',
    );

    // Step 4: Kill the sleep process (Ctrl+C)
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('c');
    await ctx.page.keyboard.up('Control');

    // Step 5: Wait for the tab label to update (should show shell, not "sleep")
    // Metadata sync polls every 2s; after Ctrl+C the process exit + next poll
    // cycle can take up to 6s in CI, so use 10s timeout.
    await waitForCondition(
      ctx.page,
      async () => {
        const info = await getGroupTabInfo(ctx.page);
        const tab = info.find((t) => t.active);
        return tab && !tab.title.includes('sleep');
      },
      10000,
      'group tab to update after process exit',
    );
  });
});

// ==================== Scenario: Copy mode reveals terminal history ====================

describe('Scenario: Copy mode reveals terminal history above visible content', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Wheel-scrolling up in copy mode renders consecutive history rows', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate uniquely-numbered history lines. Zero-padding the number
    // makes each marker line a unique substring search target.
    await runCommand(
      ctx.page,
      'for i in $(seq -w 1 200); do echo "BUGMARK_$i"; done',
      'BUGMARK_200',
    );
    await focusPage(ctx.page);
    await delay(DELAYS.SYNC);

    // Sanity: BUGMARK_200 is visible at the bottom; the earliest markers
    // were pushed out of the live viewport into scrollback.
    const visibleBefore = await ctx.page.evaluate(() => {
      const log = document.querySelector('[role="log"]');
      return log?.textContent || '';
    });
    expect(visibleBefore).toContain('BUGMARK_200');
    expect(visibleBefore).not.toContain('BUGMARK_001');

    // Enter copy mode via keyboard prefix+[ and wait for the full scrollback
    // chunk to load. cs.loading flips to false once COPY_MODE_CHUNK_LOADED
    // has populated the lines map for every absolute row.
    await enterCopyModeAndWait(ctx.page);
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot();
        const paneId = snap?.context?.activePaneId;
        const cs = snap?.context?.copyModeStates?.[paneId];
        return cs && cs.loading === false && cs.historySize >= 150;
      },
      { timeout: 10000, polling: 100 },
    );

    // Wheel-scroll upward in increments. This is the path the bug was
    // reported under: scrollTop changes per wheel event while visibleCount
    // (≈ 3 × pane height) stays the same, exercising the incremental DOM
    // update path in ScrollbackTerminal.
    const paneCenter = await ctx.page.evaluate(() => {
      const pane = document.querySelector('[data-pane-id]');
      const r = pane.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await ctx.page.mouse.move(paneCenter.x, paneCenter.y);
    // Record what the page actually sees for each wheel, and whether the
    // scroll container moved in response. Read back only on failure.
    await ctx.page.evaluate(() => {
      const w = window;
      w.__wheelLog = [];
      w.addEventListener(
        'wheel',
        (e) => {
          const el = document.querySelector('.pane-scroll-container');
          const before = el ? el.scrollTop : null;
          requestAnimationFrame(() => {
            w.__wheelLog.push({
              dy: e.deltaY,
              mode: e.deltaMode,
              defaultPrevented: e.defaultPrevented,
              target: (e.target instanceof Element ? e.target.className : '') || String(e.target),
              before,
              after: el ? el.scrollTop : null,
            });
          });
        },
        { passive: true },
      );
    });
    // Scroll until the render window has fully cleared the bottom row, rather
    // than a fixed number of ticks. ScrollbackTerminal keeps an overscan of
    // whole screens below the viewport, so how far "far enough" is grows with
    // the pane height AND with the overscan the renderer happens to use — a
    // fixed tick count, or a bound written against one overscan setting, leaves
    // BUGMARK_200 inside the window on a tall pane, and the assertion below
    // reads that as "the DOM never followed the scroll". Ask the DOM instead:
    // the condition IS that the bottom marker is no longer mounted. A
    // scrollback that is not open YET means the wheel has more work to do, not
    // less — reading a missing element as "done" broke the loop on its first
    // pass, before a single tick, and the assertion below then read a pane
    // still sitting at the bottom as "the DOM never followed the scroll".
    const needsMoreScroll = () =>
      ctx.page.evaluate(() => {
        const sb = document.querySelector('[data-copy-mode="true"]');
        // Not open yet: the wheel has more work to do, not less.
        if (!sb) return true;
        const text = sb.textContent || '';
        // Open, but showing no marker at all — the rows are still the dim
        // placeholders. The chunk being in STATE does not mean it has been
        // painted: ScrollbackTerminal paints from the scroll container's own
        // event, deliberately not from the machine. So the absence of
        // BUGMARK_200 is only evidence of having scrolled past it once some
        // marker is actually on screen; before that it means "not drawn yet".
        if (!/BUGMARK_\d+/.test(text)) return true;
        return /BUGMARK_200\b/.test(text);
      });
    for (let i = 0; i < 40; i++) {
      if (!(await needsMoreScroll())) break;
      await ctx.page.mouse.wheel(0, -200);
      await delay(150);
    }
    await delay(DELAYS.SYNC);

    // After several wheel ticks we expect to be partway up the scrollback.
    const cs = await getCopyModeState(ctx.page);
    if (cs.scrollTop >= cs.totalLines - cs.height) {
      const painted = await ctx.page.evaluate(() => {
        const sb = document.querySelector('[data-copy-mode="true"]');
        const el = document.querySelector('.pane-scroll-container');
        const before = el ? el.scrollTop : null;
        // Does the container move at all when asked directly? This separates
        // "the wheel never reached the handler" from "the container cannot
        // scroll" from "it scrolled and the machine never heard about it".
        let direct = null;
        if (el) {
          el.scrollTop = Math.max(0, before - 200);
          direct = el.scrollTop;
          el.scrollTop = before;
        }
        return {
          open: !!sb,
          charHeight: window.app?.getSnapshot()?.context?.charHeight ?? null,
          scrollTop: before,
          scrollHeight: el ? el.scrollHeight : null,
          clientHeight: el ? el.clientHeight : null,
          overflowY: el ? getComputedStyle(el).overflowY : null,
          afterDirectSet: direct,
          wheelLog: (window.__wheelLog || []).slice(0, 3),
          paneBox: (() => {
            const p = document.querySelector('[data-pane-id]');
            if (!p) return null;
            const r = p.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          })(),
          atCenter: (() => {
            const p = document.querySelector('[data-pane-id]');
            if (!p) return null;
            const r = p.getBoundingClientRect();
            const e2 = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return e2 ? e2.className || e2.tagName : 'none';
          })(),
          sample: (sb?.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
        };
      });
      throw new Error(
        `the wheel never moved the view: state scrollTop ${cs.scrollTop}, bottom is ` +
          `${cs.totalLines - cs.height} (totalLines ${cs.totalLines}, height ${cs.height}). ` +
          `container scrollTop=${painted.scrollTop} scrollHeight=${painted.scrollHeight} ` +
          `clientHeight=${painted.clientHeight} overflowY=${painted.overflowY} ` +
          `charHeight=${painted.charHeight}; setting scrollTop-200 directly left it at ` +
          `${painted.afterDirectSet}. wheelLog=${JSON.stringify(painted.wheelLog)}. ` +
          `paneBox=${JSON.stringify(painted.paneBox)} elementAtPaneCenter=${painted.atCenter}. ` +
          `Showing: "${painted.sample}"`,
      );
    }

    // The regression assertion: every <.terminal-line> div rendered inside
    // the scrollback must be filled with the correct absolute row's content.
    // When the renderer reused divs across scroll positions and skipped the
    // redraw, the DOM ended up holding non-consecutive rows (e.g. div 9 →
    // BUGMARK_107, div 10 → BUGMARK_127). Extract every numeric marker and
    // verify they form a consecutive run.
    const lineNumbers = await ctx.page.evaluate(() => {
      const sb = document.querySelector('[data-copy-mode="true"]');
      if (!sb) return null;
      const out = [];
      for (const el of sb.querySelectorAll('.terminal-line')) {
        const m = (el.textContent || '').match(/BUGMARK_(\d+)/);
        out.push(m ? Number(m[1]) : null);
      }
      return out;
    });

    expect(lineNumbers).not.toBeNull();
    // Locate the contiguous stretch of marker lines (some divs at the very
    // top of scrollback may render a shell prompt or other non-marker text).
    const numericRuns = [];
    let run = [];
    for (const n of lineNumbers) {
      if (n === null) {
        if (run.length) numericRuns.push(run);
        run = [];
      } else {
        run.push(n);
      }
    }
    if (run.length) numericRuns.push(run);

    // The run covering scrollback should be at least one screen of markers.
    const longest = numericRuns.sort((a, b) => b.length - a.length)[0] || [];
    expect(longest.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < longest.length; i++) {
      expect(longest[i]).toBe(longest[i - 1] + 1);
    }
    // The rendered markers must reflect the scrolled-up position — not the
    // initial visible viewport. If scrolling updated scrollTop but the DOM
    // kept the original BUGMARK_171..200 content, the assertions above
    // (consecutive run) would still pass. Verify the bottommost markers
    // are no longer rendered and that older markers appear instead.
    expect(longest).not.toContain(200);
    expect(longest[0]).toBeLessThan(170);
  });

  // Covers the user-reported flow: "scroll up enters copy mode but I only
  // see what was already visible, not the older history." Exercises the
  // wheel-scroll entry path (which calls ENTER_COPY_MODE with scrollLines)
  // and asserts both (a) loadedRanges cover the entire absolute row range
  // after the initial FETCH_SCROLLBACK_CELLS, and (b) the rendered DOM
  // shows the oldest history at the top after wheeling all the way up. A
  // silent fetch failure, an off-by-one in the range conversion, or a
  // re-render that fails to redraw the divs would all surface here.
  test('Wheel-scrolling up opens the scroll view with the entire scrollback loaded', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await runCommand(
      ctx.page,
      'for i in $(seq -w 1 200); do echo "WHEELMARK_$i"; done',
      'WHEELMARK_200',
    );
    await focusPage(ctx.page);
    await delay(DELAYS.SYNC);

    // Wheel-scroll up over the pane — this is the user-reported entry point.
    // The wheel handler in usePaneMouse sends ENTER_SCROLL_MODE with a
    // negative `scrollLines`, which the state machine seeds with a
    // partially-scrolled scrollTop. The bug surfaces if the subsequent
    // FETCH_SCROLLBACK_CELLS doesn't populate the absolute rows above the
    // initially-visible portion.
    const paneCenter = await ctx.page.evaluate(() => {
      const pane = document.querySelector('[data-pane-id]');
      const r = pane.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await ctx.page.mouse.move(paneCenter.x, paneCenter.y);
    // Wheel-scroll up continuously without pausing to let the initial
    // FETCH_SCROLLBACK_CELLS complete. Mirrors the user-reported flow of
    // grabbing the trackpad and going. While `loading` is true,
    // getNeededChunk suppresses follow-up fetches, so the rendered
    // content must come from the initial pre-fetch (the full history),
    // not from on-demand chunking.
    for (let i = 0; i < 30; i++) {
      await ctx.page.mouse.wheel(0, -400);
      await delay(30);
    }
    await delay(DELAYS.SYNC);

    // Wait until the scroll view is open and the loaded ranges cover the
    // entire scrollback (loading may bounce true/false as follow-up
    // chunks land, so check loadedRanges directly).
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot();
        const paneId = snap?.context?.activePaneId;
        const cs = snap?.context?.copyModeStates?.[paneId];
        if (!cs || cs.mode !== 'scroll') return false;
        if (cs.historySize < 150) return false;
        if (cs.loading) return false;
        if (cs.loadedRanges.length === 0) return false;
        const first = cs.loadedRanges[0];
        const last = cs.loadedRanges[cs.loadedRanges.length - 1];
        return first[0] <= 0 && last[1] >= cs.totalLines - 1;
      },
      { timeout: 10000, polling: 100 },
    );

    const csTop = await getCopyModeState(ctx.page);
    expect(csTop.scrollTop).toBeLessThan(50); // close enough to top

    // After scrolling to scrollTop=0 via wheel, the rendered DOM should
    // show the OLDEST content at the top, not the pane's initial visible
    // area. WHEELMARK_001 lives at the start of scrollback and must
    // appear in the rendered scrollback (the scroll view, not copy mode —
    // a wheel never enters a mode).
    const renderedText = await ctx.page.evaluate(() => {
      const sb = document.querySelector('[data-testid="scrollback-terminal"]');
      if (!sb) return null;
      return Array.from(sb.querySelectorAll('.terminal-line'))
        .slice(0, 20)
        .map((el) => el.textContent || '')
        .join('\n');
    });
    expect(renderedText).not.toBeNull();
    expect(renderedText).toMatch(/WHEELMARK_0*1\b/);
    // The bottom-of-screen markers (WHEELMARK_200) must NOT be in the top
    // viewport after wheel-scrolling to row 0.
    expect(renderedText).not.toContain('WHEELMARK_200');
  });

  // Reactive (server-initiated) copy-mode entry — e.g. a CLI
  // `tmuxy run copy-mode -t %X` or any custom binding that flips tmux's
  // `in_mode` without going through the frontend's SEND_TMUX_COMMAND
  // intercept — used to fetch only `height + 200` history lines. Anything
  // older than that 200-line slab was invisible on scroll. Fix 1 unifies
  // this path with the user-initiated one (full live history).
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
    await delay(DELAYS.SYNC);

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
    await delay(DELAYS.LONG);

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
    await delay(DELAYS.MEDIUM);

    const topText = await ctx.page.evaluate(() => {
      const sb = document.querySelector('[data-copy-mode="true"]');
      if (!sb) return null;
      return Array.from(sb.querySelectorAll('.terminal-line'))
        .slice(0, 40)
        .map((el) => el.textContent || '')
        .join('\n');
    });
    expect(topText).not.toBeNull();
    expect(topText).toMatch(/REACTIVE_0*1\b/);
    // The newer end-of-history markers must NOT be at the top after
    // scrolling to row 0 — that would mean the lines Map is misaligned.
    expect(topText).not.toContain('REACTIVE_500');
  });

  // The reported user flow: open tmuxy, run a command that produces more
  // lines than fit in the pane, hit `<prefix>[`, scroll up — expect older
  // history. This test reproduces that exactly via keyboard, with no wheel
  // or CLI entry path, and dumps the copy-mode state at each step so any
  // failure shows precisely which hop dropped the scrollback (the live
  // pane.historySize, the post-entry copyModeStates entry, the FETCH
  // response merge, or the rendered DOM).
  test('Standard `<prefix>[` + scroll-up shows scrollback older than the pane height', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 1) Produce well-past-pane-height output. SCROLLBUG_001..SCROLLBUG_200.
    await runCommand(
      ctx.page,
      'for i in $(seq -w 1 200); do echo "SCROLLBUG_$i"; done',
      'SCROLLBUG_200',
    );
    await focusPage(ctx.page);
    await delay(DELAYS.SYNC);

    // 2) The LIVE pane must already report real history. If pane.historySize
    //    is 0 here the bug is on the ingress side (server initial state or
    //    delta missing the field) and the FETCH below will request only the
    //    visible band — which is exactly the original user-reported symptom.
    const before = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      const c = snap?.context;
      const pane = c?.panes?.find((p) => p.tmuxId === c.activePaneId);
      return { historySize: pane?.historySize ?? null };
    });
    expect(before.historySize).toBeGreaterThan(0);

    // 3) Enter copy mode via the user-canonical keyboard path.
    const csEntry = await enterCopyModeAndWait(ctx.page);
    expect(csEntry.active).toBe(true);

    // Wait for the initial FETCH_SCROLLBACK_CELLS response to fully populate
    // the loadedRanges. With the server fix, pane.historySize is correct
    // from the first connect, so the initial fetch covers the full history.
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot();
        const id = snap?.context?.activePaneId;
        const cs = snap?.context?.copyModeStates?.[id];
        if (!cs || cs.loading || cs.loadedRanges.length === 0) return false;
        const first = cs.loadedRanges[0];
        const last = cs.loadedRanges[cs.loadedRanges.length - 1];
        return first[0] <= 0 && last[1] >= cs.totalLines - 1;
      },
      { timeout: 15000, polling: 100 },
    );

    // 4) Scroll to the very top via the state machine.
    await ctx.page.evaluate(() => {
      const id = window.app?.getSnapshot()?.context?.activePaneId;
      window.app?.send({ type: 'COPY_MODE_SCROLL', paneId: id, scrollTop: 0 });
    });
    await delay(DELAYS.MEDIUM);

    // 5) The actual DOM rendered in the ScrollbackTerminal.
    const renderedText = await ctx.page.evaluate(() => {
      const sb = document.querySelector('[data-copy-mode="true"]');
      if (!sb) return null;
      return Array.from(sb.querySelectorAll('.terminal-line'))
        .map((el) => el.textContent || '')
        .join('\n');
    });

    // 6) The actual assertion — the bug as reported. Pre-fix, the oldest
    //    marker is nowhere in the DOM and the user sees blanks / placeholders
    //    instead of real scrollback content.
    expect(renderedText).not.toBeNull();
    expect(renderedText).toMatch(/SCROLLBUG_0*1\b/);
    expect(renderedText).not.toContain('SCROLLBUG_200');
  });
});

// ==================== Scenario: keystrokes route to clicked pane-group tab ====================

describe('Scenario: keystrokes route to the clicked pane-group tab', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

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
    await delay(DELAYS.SYNC);

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

  test('Clicking three pane-group tabs in rapid succession never flashes a non-target pane in the visible slot', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Build a 3-pane group with distinct content per pane so we can fingerprint
    // which pane is in the visible window slot at every captured frame.
    await runCommand(ctx.page, 'echo ALPHA_TAB', 'ALPHA_TAB');
    const alphaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(alphaId).not.toBeNull();

    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await delay(DELAYS.SYNC);
    await runCommand(ctx.page, 'echo BETA_TAB', 'BETA_TAB');
    const betaId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId || null,
    );
    expect(betaId).not.toBeNull();
    expect(betaId).not.toBe(alphaId);

    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    await delay(DELAYS.SYNC);
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

  test('Creating tabs then switching keeps the rendered tab in sync with tmux', async () => {
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
      await delay(DELAYS.SYNC);
    }
    await waitForWindowCount(ctx.page, 4, 15000);
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

  test('tmux’s message appears top-right, off the status line, and the close button dismisses it', async () => {
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
