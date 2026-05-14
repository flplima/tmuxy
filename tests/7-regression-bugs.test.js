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
  waitForCondition,
  runCommand,
  focusPage,
  enterCopyModeAndWait,
  getCopyModeState,
  DELAYS,
} = require('./helpers');

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
      const hasContent = pane.content.some(line =>
        line.some(cell => cell.c && cell.c !== ' ')
      );
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
      return Array.from(tabs).map(t => t.textContent.trim());
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
    await waitForCondition(ctx.page, async () => {
      const info = await getGroupTabInfo(ctx.page);
      const tab = info.find(t => t.active);
      return tab && tab.title.includes('sleep');
    }, 5000, 'group tab to show "sleep"');

    // Step 4: Kill the sleep process (Ctrl+C)
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('c');
    await ctx.page.keyboard.up('Control');

    // Step 5: Wait for the tab label to update (should show shell, not "sleep")
    // Metadata sync polls every 2s; after Ctrl+C the process exit + next poll
    // cycle can take up to 6s in CI, so use 10s timeout.
    await waitForCondition(ctx.page, async () => {
      const info = await getGroupTabInfo(ctx.page);
      const tab = info.find(t => t.active);
      return tab && !tab.title.includes('sleep');
    }, 10000, 'group tab to update after process exit');
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
    const sessionName = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.sessionName || ''
    );
    const { execSync } = require('child_process');
    const status = execSync(
      `tmux show-options -t ${sessionName} -v pane-border-status 2>/dev/null || echo "off"`,
      { encoding: 'utf-8', timeout: 5000 }
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
        windowCount: cctx?.windows?.filter((w) => !w.isPaneGroupWindow && !w.isFloatWindow).length ?? 0,
      };
    });
    expect(beforeSwitch.itemCount).toBeGreaterThanOrEqual(1);
    expect(beforeSwitch.text).toContain('TAB_TWO_MARKER');
    // Both visible windows must have at least one pane cached on the client.
    expect(beforeSwitch.windowIdsWithPanes.length).toBeGreaterThanOrEqual(
      beforeSwitch.windowCount,
    );

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
