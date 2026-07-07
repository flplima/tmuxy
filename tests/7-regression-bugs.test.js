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
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  createWindowKeyboard,
  splitPaneKeyboard,
  clickPaneGroupAdd,
  getGroupTabInfo,
  waitForGroupTabs,
  waitForCondition,
  runCommand,
  focusPage,
  enterCopyModeAndWait,
  getCopyModeState,
  DELAYS,
} = require('./helpers');
const { tmuxCmd } = require('./helpers/tmux-socket');

// ==================== Scenario: Content persistence after split/close ====================

describe('Scenario: Content persistence after split/close', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Pane content renders for pre-existing session', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // BUG 1+3: Pre-existing pane content must render, not show blank terminals.
    // The fix preserves non-empty content when state updates arrive with empty
    // pane content (race between vt100 parser reset and capture-pane refill).
    // Verify that a command's output is visible in the terminal.
    const marker = `RENDER_${Date.now()}`;
    await runCommand(ctx.page, `echo ${marker}`, marker);

    // Verify the XState machine context has non-empty pane content
    const stateCheck = await ctx.page.evaluate(() => {
      const snap = window.app?.getSnapshot();
      const ctx = snap?.context;
      if (!ctx || !ctx.panes || ctx.panes.length === 0) return { error: 'no panes' };
      const pane = ctx.panes[0];
      const hasContent = pane.content.some((line) => line.some((cell) => cell.c && cell.c !== ' '));
      return { hasContent, paneCount: ctx.panes.length };
    });
    expect(stateCheck.error).toBeUndefined();
    expect(stateCheck.hasContent).toBe(true);
  });
});

// ==================== Scenario: Viewport sizing fills browser ====================

describe('Scenario: Viewport sizing fills browser', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Pane layout fills the browser viewport width', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Wait for layout to settle
    await delay(DELAYS.SYNC);

    // Verify pane fills most of the viewport width
    const result = await ctx.page.evaluate(() => {
      const vw = window.innerWidth;
      const panes = document.querySelectorAll('[data-pane-id]');
      if (panes.length === 0) {
        const logs = document.querySelectorAll('[role="log"]');
        if (logs.length === 0) return { error: 'no panes found' };
        const rect = logs[0].parentElement.getBoundingClientRect();
        return { paneRight: rect.right, viewportWidth: vw };
      }
      // Find the rightmost pane edge
      let maxRight = 0;
      for (const pane of panes) {
        const rect = pane.getBoundingClientRect();
        if (rect.right > maxRight) maxRight = rect.right;
      }
      return { paneRight: maxRight, viewportWidth: vw };
    });

    expect(result.error).toBeUndefined();
    // Pane layout should use at least 80% of viewport width
    // (some padding/margin is expected)
    const usageRatio = result.paneRight / result.viewportWidth;
    expect(usageRatio).toBeGreaterThan(0.8);
  });
});

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

// ==================== Scenario: Pane border artifacts suppressed ====================

describe('Scenario: Pane border-status enforced to top', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('pane-border-status is top after server connection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Query tmux for pane-border-status setting
    const borderStatus = await ctx.page.evaluate(async () => {
      const session = window.app?.getSnapshot()?.context?.sessionName || '';
      const resp = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-Id': '1' },
        body: JSON.stringify({
          cmd: 'run_tmux_command',
          args: { command: 'display-message -p "#{pane-border-status}"' },
        }),
      });
      return resp.ok;
    });

    // enforce_settings() sets pane-border-status at session level (not global).
    // PaneLayout relies on this — with it off, y=0 panes lose 1 row of content.
    const sessionName = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.sessionName || '',
    );
    const { execSync } = require('child_process');
    const status = execSync(
      `tmux show-options -t ${sessionName} -v pane-border-status 2>/dev/null || echo "off"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    expect(status).toBe('top');
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
    for (let i = 0; i < 6; i++) {
      await ctx.page.mouse.wheel(0, -200);
      await delay(150);
    }
    await delay(DELAYS.SYNC);

    // After several wheel ticks we expect to be partway up the scrollback.
    const cs = await getCopyModeState(ctx.page);
    expect(cs.scrollTop).toBeLessThan(cs.totalLines - cs.height);

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
  test('Entering copy mode via wheel-scroll loads the entire scrollback', async () => {
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
    // The wheel handler in usePaneMouse sends ENTER_COPY_MODE with a
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

    // Wait until copy mode is active and the loaded ranges cover the
    // entire scrollback (loading may bounce true/false as follow-up
    // chunks land, so check loadedRanges directly).
    await ctx.page.waitForFunction(
      () => {
        const snap = window.app?.getSnapshot();
        const paneId = snap?.context?.activePaneId;
        const cs = snap?.context?.copyModeStates?.[paneId];
        if (!cs) return false;
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
    // appear in the rendered <pre>.
    const renderedText = await ctx.page.evaluate(() => {
      const sb = document.querySelector('[data-copy-mode="true"]');
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

    // Dump state to diagnose what landed.
    const dbg = await ctx.page.evaluate((id) => {
      const snap = window.app?.getSnapshot();
      const cs = snap?.context?.copyModeStates?.[id];
      const pane = snap?.context?.panes?.find((p) => p.tmuxId === id);
      return {
        paneInMode: pane?.inMode,
        paneHistorySize: pane?.historySize,
        cs: cs
          ? {
              historySize: cs.historySize,
              totalLines: cs.totalLines,
              loading: cs.loading,
              loadedRanges: JSON.stringify(cs.loadedRanges),
              linesCount: cs.lines.size,
            }
          : null,
      };
    }, paneId);
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

  // Direct server-API probe. The user-flow test above passes for many
  // timings — but the server-side root cause is testable on its own and
  // is timing-independent: `get_initial_state` must surface the real
  // `history_size` for every pane that has scrollback. The Rust
  // `capture_window_state_for_session` in tmuxy-core/src/lib.rs hardcodes
  // it to 0 ("not available in polling mode") because the list-panes
  // format string used there doesn't include `#{history_size}`. The
  // frontend's `pane.historySize ?? 0` therefore lands as 0 on every
  // fresh connection, and ENTER_COPY_MODE asks the server for
  // `start: -0..height-1` — i.e. ONLY the visible viewport — until a
  // later control-mode `list-panes` delta finally delivers the real value.
  //
  // This test pokes /commands directly from the page so it doesn't have
  // to win a race against control mode. With scrollback present in tmux,
  // an initial-state response that reports `history_size: 0` is the bug.
  test('get_initial_state returns the real history_size for panes with scrollback', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Build scrollback so tmux's `#{history_size}` is > 0.
    await runCommand(
      ctx.page,
      'for i in $(seq -w 1 200); do echo "INITIALMARK_$i"; done',
      'INITIALMARK_200',
    );
    await delay(DELAYS.SYNC);

    // Confirm tmux really has the history we just created. Read via the
    // page so we go through the same adapter the frontend uses — no
    // bypassing `tmuxQuery` from a .test.js file.
    const sessionName = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.sessionName || null;
    });
    expect(sessionName).not.toBeNull();

    // Probe get_initial_state directly. This is the call the frontend
    // makes on every fresh connect (HttpAdapter / TauriAdapter) and the
    // response is what populates pane.historySize before any control-mode
    // delta lands. We assert AGAINST the server's response, not against
    // any post-delta corrected state.
    const initialState = await ctx.page.evaluate(async (session) => {
      const url = `/commands?session=${encodeURIComponent(session)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'get_initial_state', args: { cols: 80, rows: 24 } }),
      });
      if (!res.ok) return { error: `HTTP ${res.status}`, body: await res.text() };
      return res.json();
    }, sessionName);

    // /commands wraps successful results in `{result: ...}`.
    const stateBody = initialState?.result ?? initialState;

    // The frontend reads `history_size` (snake_case) off this exact payload
    // before camelizing. With 200 lines of scrollback live in tmux, at least
    // one pane in the response must report a non-zero history_size. Pre-fix
    // every pane reported 0 because the polling-mode list-panes format
    // string omitted `#{history_size}` and `capture_window_state` hardcoded
    // it to 0 — every fresh connect's initial state then fed
    // pane.historySize = 0 to ENTER_COPY_MODE, which asked the server for
    // `start: -0..height-1` (visible band only) and never loaded scrollback.
    expect(stateBody).toBeTruthy();
    expect(Array.isArray(stateBody.panes)).toBe(true);
    const panesWithHistory = stateBody.panes.filter((p) => p.history_size > 0);
    expect(panesWithHistory.length).toBeGreaterThan(0);
  });
});

// ==================== Scenario: Tab switch is instant (no empty-pane flash) ====================

describe('Scenario: Tab switch shows panes instantly', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Switching to a tab renders the cached pane content without a transient empty frame', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Window 1: leave a distinctive marker so we can detect its pane content.
    await runCommand(ctx.page, 'echo TAB_ONE_MARKER', 'TAB_ONE_MARKER');
    await delay(DELAYS.SHORT);

    // Create window 2 and leave a different marker. The new-window helper
    // routes through the server's control-mode-safe new-window → split + break
    // wrapper.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await focusPage(ctx.page);
    await runCommand(ctx.page, 'echo TAB_TWO_MARKER', 'TAB_TWO_MARKER');
    await delay(DELAYS.SHORT);

    // Pre-flight: we're on window 2 and TAB_TWO_MARKER is in the visible pane.
    // Also confirm both windows' panes are cached in context.panes — this is
    // the precondition for SELECT_TAB to feel instant. The previous bug was
    // the server only sending panes for the active window, leaving nothing
    // to render when activeWindowId flipped optimistically.
    const beforeSwitch = await ctx.page.evaluate(() => {
      const items = document.querySelectorAll('.pane-layout-item');
      const text = Array.from(items)
        .map((it) => it.textContent || '')
        .join(' ');
      const cctx = window.app?.getSnapshot()?.context;
      return {
        itemCount: items.length,
        text: text.slice(0, 200),
        windowIdsWithPanes: cctx?.panes
          ? Array.from(new Set(cctx.panes.map((p) => p.windowId))).sort()
          : [],
        windowCount: cctx?.windows?.filter((w) => w.windowType === 'tab').length ?? 0,
      };
    });
    expect(beforeSwitch.itemCount).toBeGreaterThanOrEqual(1);
    expect(beforeSwitch.text).toContain('TAB_TWO_MARKER');
    // Both visible windows must have at least one pane cached on the client.
    expect(beforeSwitch.windowIdsWithPanes.length).toBeGreaterThanOrEqual(beforeSwitch.windowCount);

    // Wire up two complementary watchers BEFORE the click so we don't miss
    // any state between click and first paint:
    //
    // 1) MutationObserver on .pane-layout — fires on every DOM mutation that
    //    touches pane structure or text content. Captures intermediate React
    //    commits the RAF sampler can miss when multiple commits land in the
    //    same animation frame.
    //
    // 2) requestAnimationFrame sampler — captures paint-aligned snapshots so
    //    we know what the user actually sees each frame for ~400ms.
    await ctx.page.evaluate(() => {
      window.__tabSwitchSamples = [];
      window.__tabSwitchMutations = [];
      window.__tabSwitchT0 = null;

      function snapshotPanes() {
        const items = document.querySelectorAll('.pane-layout-item');
        const out = [];
        for (const it of items) {
          const r = it.getBoundingClientRect();
          const log = it.querySelector('[role="log"]');
          const lines = it.querySelectorAll('.terminal-line');
          const text = (log?.textContent || '').replace(/\s+/g, ' ').trim();
          out.push({
            id: it.getAttribute('data-pane-id'),
            w: Math.round(r.width),
            h: Math.round(r.height),
            lineCount: lines.length,
            textLen: text.length,
            hasOne: text.includes('TAB_ONE_MARKER'),
            hasTwo: text.includes('TAB_TWO_MARKER'),
          });
        }
        return out;
      }

      window.__snapshotPanes = snapshotPanes;

      const observer = new MutationObserver(() => {
        if (window.__tabSwitchT0 === null) return;
        const dt = Math.round(performance.now() - window.__tabSwitchT0);
        const panes = snapshotPanes();
        window.__tabSwitchMutations.push({ dt, panes });
      });
      const root = document.querySelector('.pane-layout') || document.body;
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      window.__tabSwitchObserver = observer;

      function sample(t0) {
        if (window.__tabSwitchT0 === null) {
          requestAnimationFrame(() => sample(t0));
          return;
        }
        const dt = Math.round(performance.now() - window.__tabSwitchT0);
        const panes = snapshotPanes();
        window.__tabSwitchSamples.push({ dt, itemCount: panes.length, panes });
        if (dt < 400) requestAnimationFrame(() => sample(t0));
      }
      requestAnimationFrame(() => sample(performance.now()));
    });

    // Click tab 1 in the same evaluate so the t0 we record lines up with
    // the click event — both watchers gate on __tabSwitchT0 being non-null.
    await ctx.page.evaluate(() => {
      window.__tabSwitchT0 = performance.now();
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      if (tabs[0]) tabs[0].click();
    });

    // Wait for the watchers to finish ~400ms of frames.
    await delay(600);
    const { samples, mutations } = await ctx.page.evaluate(() => ({
      samples: window.__tabSwitchSamples,
      mutations: window.__tabSwitchMutations,
    }));

    // Sanity: we captured at least a few frames + the observer fired.
    expect(samples.length).toBeGreaterThan(3);
    expect(mutations.length).toBeGreaterThan(0);

    // Empty-pane assertion across BOTH watchers. A frame is "empty" when
    // panes exist but none contains visible text in a [role="log"] with
    // at least one rendered .terminal-line. The MutationObserver path
    // catches any intermediate DOM commit; the RAF path catches what the
    // user actually sees between vsync events.
    const isEmptyFrame = (s) =>
      s.panes.length > 0 &&
      s.panes.every((p) => p.textLen < 5 || p.lineCount === 0 || p.w === 0 || p.h === 0);
    const emptyRaf = samples.filter(isEmptyFrame);
    const emptyMutation = mutations.filter(isEmptyFrame);
    if (emptyRaf.length > 0 || emptyMutation.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'empty frames (raf):',
        JSON.stringify(emptyRaf.slice(0, 3), null, 2),
        '\nempty frames (mutation):',
        JSON.stringify(emptyMutation.slice(0, 3), null, 2),
      );
    }
    expect(emptyRaf).toEqual([]);
    expect(emptyMutation).toEqual([]);

    // From the very first RAF after the click, the target window's marker
    // must already be visible in a pane. This is the "instant" assertion —
    // the optimistic activeWindowId flip and the cached pane content must
    // be applied in the same React commit that the click event triggers,
    // so the next browser paint shows the target tab.
    const firstFrame = samples[0];
    expect(firstFrame.panes.some((p) => p.hasOne)).toBe(true);
    expect(firstFrame.panes.every((p) => !p.hasTwo)).toBe(true);

    // And the first mutation observation must already show the target
    // window's panes — i.e. the synchronous React commit from the click
    // event handler must replace window 2's DOM with window 1's DOM in
    // one batch, with no transient state where the layout is empty.
    const firstMutation = mutations[0];
    expect(firstMutation.panes.some((p) => p.hasOne)).toBe(true);
  });

  test('Switching to a multi-pane tab renders all panes from the first paint', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Window 1: split into 3 panes with distinct markers so we can detect
    // each one individually. Multi-pane tabs are the scenario where the
    // emptiness is most visible — a single-pane tab can mask layout-shift
    // bugs because the geometry barely changes.
    await runCommand(ctx.page, 'echo W1_PANE_A', 'W1_PANE_A');
    await delay(DELAYS.SHORT);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await runCommand(ctx.page, 'echo W1_PANE_B', 'W1_PANE_B');
    await delay(DELAYS.SHORT);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await runCommand(ctx.page, 'echo W1_PANE_C', 'W1_PANE_C');
    await delay(DELAYS.SHORT);

    // Window 2 with a single pane.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await focusPage(ctx.page);
    await runCommand(ctx.page, 'echo W2_PANE_X', 'W2_PANE_X');
    await delay(DELAYS.SHORT);

    // Install the MutationObserver + RAF watchers.
    await ctx.page.evaluate(() => {
      window.__multiSamples = [];
      window.__multiMutations = [];
      window.__multiT0 = null;

      function snapshotPanes() {
        const items = document.querySelectorAll('.pane-layout-item');
        const out = [];
        for (const it of items) {
          const r = it.getBoundingClientRect();
          const log = it.querySelector('[role="log"]');
          const lines = it.querySelectorAll('.terminal-line');
          const text = (log?.textContent || '').replace(/\s+/g, ' ').trim();
          out.push({
            id: it.getAttribute('data-pane-id'),
            w: Math.round(r.width),
            h: Math.round(r.height),
            lineCount: lines.length,
            textLen: text.length,
            hasA: text.includes('W1_PANE_A'),
            hasB: text.includes('W1_PANE_B'),
            hasC: text.includes('W1_PANE_C'),
            hasX: text.includes('W2_PANE_X'),
          });
        }
        return out;
      }

      const observer = new MutationObserver(() => {
        if (window.__multiT0 === null) return;
        const dt = Math.round(performance.now() - window.__multiT0);
        window.__multiMutations.push({ dt, panes: snapshotPanes() });
      });
      const root = document.querySelector('.pane-layout') || document.body;
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      function sample(t0) {
        if (window.__multiT0 === null) {
          requestAnimationFrame(() => sample(t0));
          return;
        }
        const dt = Math.round(performance.now() - window.__multiT0);
        window.__multiSamples.push({ dt, panes: snapshotPanes() });
        if (dt < 400) requestAnimationFrame(() => sample(t0));
      }
      requestAnimationFrame(() => sample(performance.now()));
    });

    // Click tab 1 to switch from window 2 back to the multi-pane window 1.
    await ctx.page.evaluate(() => {
      window.__multiT0 = performance.now();
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      if (tabs[0]) tabs[0].click();
    });

    await delay(600);
    const { samples, mutations } = await ctx.page.evaluate(() => ({
      samples: window.__multiSamples,
      mutations: window.__multiMutations,
    }));

    expect(samples.length).toBeGreaterThan(3);

    // Frame is "empty" if panes exist but none has visible terminal content.
    const isEmpty = (s) =>
      s.panes.length > 0 &&
      s.panes.every((p) => p.textLen < 5 || p.lineCount === 0 || p.w === 0 || p.h === 0);
    const emptyRaf = samples.filter(isEmpty);
    const emptyMutation = mutations.filter(isEmpty);
    if (emptyRaf.length > 0 || emptyMutation.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'multi empty frames (raf):',
        JSON.stringify(emptyRaf.slice(0, 3), null, 2),
        '\nmulti empty frames (mutation):',
        JSON.stringify(emptyMutation.slice(0, 3), null, 2),
      );
    }
    expect(emptyRaf).toEqual([]);
    expect(emptyMutation).toEqual([]);

    // The first RAF after the click must already show all three of
    // window 1's panes with their markers — none of window 2's pane (X)
    // should be visible. This is the "instantly optimistic" guarantee:
    // cached pane content must render from the same React commit as
    // the activeWindowId flip.
    const firstFrame = samples[0];
    expect(firstFrame.panes.length).toBeGreaterThanOrEqual(3);
    expect(firstFrame.panes.some((p) => p.hasA)).toBe(true);
    expect(firstFrame.panes.some((p) => p.hasB)).toBe(true);
    expect(firstFrame.panes.some((p) => p.hasC)).toBe(true);
    expect(firstFrame.panes.every((p) => !p.hasX)).toBe(true);

    // First DOM mutation after click must already reflect all three target
    // panes. Mutation observers fire on each React commit, so this catches
    // the case where the layout flips activeWindowId but renders an empty
    // grid before the cached panes are projected into selectVisiblePanes.
    expect(mutations.length).toBeGreaterThan(0);
    const firstMutation = mutations[0];
    expect(firstMutation.panes.length).toBeGreaterThanOrEqual(3);
    expect(firstMutation.panes.some((p) => p.hasA)).toBe(true);
    expect(firstMutation.panes.some((p) => p.hasB)).toBe(true);
    expect(firstMutation.panes.some((p) => p.hasC)).toBe(true);

    // No frame at any point should show the previous tab's pane content.
    // If activeWindowId flips but selectVisiblePanes still returns the old
    // window's panes (memoization or stale closure), the X marker would
    // leak through.
    const framesWithStaleContent = samples.filter((s) => s.panes.some((p) => p.hasX));
    expect(framesWithStaleContent).toEqual([]);
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
    const marker = `ALPHAKEY${Date.now()}`;
    await ctx.page.evaluate((idx) => {
      const tabEls = document.querySelectorAll('.pane-tabs .pane-tab');
      if (tabEls[idx]) tabEls[idx].click();
    }, alphaTabIdx);

    // Fire keystrokes via the page-level keyboard so they go through the
    // same `window.addEventListener('keydown')` path the keyboardActor uses.
    // The keyboardActor's local `activePaneId` is what decides the -t target;
    // pre-fix it would still be BETA's id and the marker would land in BETA.
    for (const ch of marker) {
      await ctx.page.keyboard.type(ch);
    }
    await ctx.page.keyboard.press('Enter');

    // Wait for the marker to appear in the visible pane (ALPHA after the
    // optimistic swap completes). If routing is broken, the marker lands
    // in BETA and never shows up here — the wait times out and the
    // expectation below fails, which is the regression we want to catch.
    await waitForTerminalText(ctx.page, marker, 10000);

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
      10000,
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
      // eslint-disable-next-line no-console
      console.log('multi-marker frames:', JSON.stringify(multiMarkerFrames.slice(0, 3), null, 2));
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
    const out = require('child_process')
      .execSync(`${tmuxCmd()} list-windows -t ${ctx.session.name} -F '#{window_id}|#{window_active}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      .trim();
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
    expect(`${label}: ${JSON.stringify(state.flagged)}`).toBe(`${label}: ${JSON.stringify([truth])}`);
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
