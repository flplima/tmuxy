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
