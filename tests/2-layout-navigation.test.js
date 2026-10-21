/**
 * Layout & Navigation E2E Tests (Tab Strip Drag, Input Routing & No-Blink Switch)
 */

const {
  createTestContext,
  delay,
  focusPage,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  splitPaneKeyboard,
  createWindowKeyboard,
  waitForShellPrompt,
  waitForLayoutSettled,
  waitForCondition,
  waitForSettled,
} = require('./helpers/layout-helpers');

// ==================== Scenario 4e: Tab Overview and ctrl+N by position ====================

describe('Scenario 4e: Tab Overview and ctrl+N by position', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The strip itself reorders by drag, like the overview's cards: a press that
  // travels lifts the tab, the tab it would precede shows the drop bar, and
  // the drop is a move — not a click — so the active tab does not change.
  test('a tab dragged along the strip lands where it was dropped, in the client and in tmux', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    await createWindowKeyboard(page);
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 3);

    const strip = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.tab-list .tab-name[data-window-id]')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.windowId,
            active: el.getAttribute('aria-selected') === 'true',
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      );
    const before = await strip();
    expect(before).toHaveLength(3);
    const dragged = before[2].id;
    const activeBefore = before.find((t) => t.active).id;

    await page.mouse.move(before[2].x + before[2].w / 2, before[2].y + before[2].h / 2);
    await page.mouse.down();
    await page.mouse.move(before[0].x + 4, before[0].y + before[0].h / 2, { steps: 10 });
    // Mid-drag: the lifted tab rides left of where it sat and the first tab
    // carries the drop bar.
    await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const lifted = document.querySelector('.tab-name.is-dragging');
          const bar = document.querySelector('.tab-name.is-drop-before');
          return lifted?.dataset.windowId === id && bar?.dataset.windowId !== id;
        }, dragged),
      3000,
      'the lifted tab and the drop bar',
    );
    const lifted = (await strip()).find((t) => t.id === dragged);
    expect(lifted.x).toBeLessThan(before[2].x - 20);
    // The two tabs it passed have slid right by its width: the strip shows
    // the order the drop will make while the drag is still on.
    await waitForCondition(
      page,
      async () => {
        const now = await strip();
        return before
          .slice(0, 2)
          .every((t) => now.find((n) => n.id === t.id).x > t.x + before[2].w - 4);
      },
      3000,
      'the passed tabs to make way for the dragged one',
    );
    await page.mouse.up();

    await waitForCondition(
      page,
      async () => (await strip())[0]?.id === dragged,
      8000,
      'the dragged tab to become the first',
    );
    const tmuxOrder = String(await ctx.session.query("list-windows -F '#{window_id}'"))
      .split('\n')
      .filter((id) => before.some((t) => t.id === id));
    expect(tmuxOrder[0]).toBe(dragged);
    const after = await strip();
    expect(after.map((t) => t.id)).toEqual(tmuxOrder);
    expect(after.find((t) => t.active).id).toBe(activeBefore);
    expect(
      await page.evaluate(() =>
        document.querySelector('.is-dragging, .is-drop-before, .is-drop-after'),
      ),
    ).toBeNull();
  }, 60000);
});

// ==================== Scenario 23: Window Tab Input Routing ====================

describe('Scenario 23: Window Tab Input Routing', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Keyboard input targets the correct pane after clicking a window tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Record window 1 pane ID
    const win1PaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(win1PaneId).toBeTruthy();

    // Step 2: Create second window (we're now in window 2)
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    // Wait for new pane content to render via SSE (non-fatal on CI)
    try {
      await waitForShellPrompt(ctx.page);
    } catch {
      /* CI SSE may not deliver new pane content */
    }

    // Step 3: Record window 2 pane ID
    const win2PaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(win2PaneId).toBeTruthy();
    expect(win2PaneId).not.toBe(win1PaneId);

    // Step 4: Type a marker in window 2 and verify it appears in DOM
    const MARKER_W2 = `W2_MARKER_${Date.now()}`;
    await runCommand(ctx.page, `echo ${MARKER_W2}`, MARKER_W2);

    // Step 5: Click window 1 tab (the inactive one)
    await focusPage(ctx.page);
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();

    // Step 6: Verify we switched — active pane must become win1PaneId.
    // (The old version stringified a closure over win1PaneId, saw undefined
    // in the page, and swallowed the resulting failure with .catch — the
    // "verification" could not fail.)
    await ctx.session.waitForState((c, id) => c.activePaneId === id, win1PaneId, 5000);

    // Step 7: Type a marker in window 1
    const MARKER_W1 = `W1_MARKER_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${MARKER_W1}`);
    await pressEnter(ctx.page);

    // Step 8: Verify MARKER_W1 appears in the DOM (we're viewing window 1)
    await waitForTerminalText(ctx.page, MARKER_W1);

    // Step 10: Click window 2 tab, type another marker
    const tabs2 = await ctx.page.$$('.tab-name:not(.tab-add)');
    let inactiveTab2 = null;
    for (const t of tabs2) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab2 = t;
        break;
      }
    }
    expect(inactiveTab2).not.toBeNull();
    await inactiveTab2.click();
    await waitForCondition(
      ctx.page,
      () => inactiveTab2.evaluate((el) => el.classList.contains('tab-name-active')),
      8000,
      'the clicked tab to become the active one',
    );

    const MARKER_W2B = `W2B_MARKER_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${MARKER_W2B}`);
    await pressEnter(ctx.page);

    // Step 11: Verify MARKER_W2B appears in DOM (we're viewing window 2)
    await waitForTerminalText(ctx.page, MARKER_W2B);
  }, 180000);
});

// ==================== Scenario 24: Tab Switch No Blink ====================

describe('Scenario 24: Tab Switch No Blink', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Clicking an inactive tab transitions the active highlight exactly once (no A→B→A→B blink) [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create a second window so we have two tabs to switch between
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForLayoutSettled(ctx.page);

    // Install a MutationObserver inside the page that records, for each
    // observed mutation on .tab-name elements, the ordered list of tab ids
    // currently bearing `.tab-name-active`. We poll this sequence after the
    // click to verify the highlight doesn't flip-flop.
    await ctx.page.evaluate(() => {
      const list = document.querySelector('.tab-list');
      if (!list) throw new Error('No .tab-list found');

      // Tag each tab with a stable data-tab-id so the observer can identify
      // them across class mutations (using DOM order as the id).
      const tabs = list.querySelectorAll('.tab-name:not(.tab-add)');
      tabs.forEach((t, i) => t.setAttribute('data-tab-test-id', String(i)));

      const snapshot = () => {
        const out = [];
        list.querySelectorAll('.tab-name:not(.tab-add)').forEach((t) => {
          if (t.classList.contains('tab-name-active')) {
            out.push(t.getAttribute('data-tab-test-id'));
          }
        });
        return out.join(',');
      };

      const seq = [snapshot()];
      window.__tabBlinkSeq = seq;

      const obs = new MutationObserver(() => {
        const cur = snapshot();
        if (cur !== seq[seq.length - 1]) seq.push(cur);
      });
      obs.observe(list, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      window.__tabBlinkObserver = obs;
    });

    // Find the inactive tab and click it (real user path → SELECT_TAB)
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();

    // Wait well past the SELECT_TAB grace window (600ms) so any stale
    // snapshot that would cause a bounce has time to arrive and be applied.
    await delay(2000);

    // Read the observed sequence of active-tab ids
    const seq = await ctx.page.evaluate(() => {
      window.__tabBlinkObserver?.disconnect();
      return window.__tabBlinkSeq || [];
    });

    // Sanity: we should see at least the initial state and the post-click state
    expect(seq.length).toBeGreaterThanOrEqual(2);

    // Final state must be a single active tab, different from the first one
    const firstActive = seq[0];
    const lastActive = seq[seq.length - 1];
    expect(firstActive).not.toBe('');
    expect(lastActive).not.toBe('');
    expect(lastActive).not.toBe(firstActive);

    // Blink detection: the active tab must never revert to a previously-seen
    // value. Each value should appear in a single contiguous run. A blink
    // produces a sequence like [A, B, A, B] where A repeats.
    const seen = new Set();
    let prev = null;
    for (const value of seq) {
      if (value !== prev) {
        if (seen.has(value)) {
          throw new Error(
            `Tab highlight blinked: active-tab ids reverted. Sequence: ${JSON.stringify(seq)}`,
          );
        }
        seen.add(value);
        prev = value;
      }
    }

    // Stronger check: there must be exactly one transition (firstActive → lastActive)
    const transitions = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
    expect(transitions).toBe(1);
  }, 60000);

  test('Switching to a tab whose active pane is not its first lands on that pane at once (no first-pane hop) [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    const state = () =>
      page.evaluate(() => {
        const c = window.app?.getSnapshot()?.context;
        return { window: c?.activeWindowId, pane: c?.activePaneId, panes: c?.panes?.length };
      });
    const ctrl = async (key) => {
      await page.keyboard.down('Control');
      await page.keyboard.press(key);
      await page.keyboard.up('Control');
    };

    // A second tab with two panes, the SECOND one active (a split activates
    // the new pane), then back to the first tab.
    const firstTab = (await state()).window;
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 2);
    const secondTab = (await state()).window;
    expect(secondTab).not.toBe(firstTab);
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 3);
    const rightPane = (await state()).pane;
    // Tab 2's panes by geometry: the split put the new, active pane on the
    // right; the left one is where a wrong guess would land.
    const secondTabPanes = await page.evaluate(
      (id) =>
        window.app
          ?.getSnapshot()
          ?.context?.panes.filter((p) => p.windowId === id)
          .sort((a, b) => a.x - b.x)
          .map((p) => p.tmuxId),
      secondTab,
    );
    expect(secondTabPanes).toHaveLength(2);
    expect(secondTabPanes[1]).toBe(rightPane);
    await ctrl('1');
    await waitForCondition(
      page,
      async () => (await state()).window === firstTab,
      8000,
      'the first tab to become current',
    );

    // A fresh client (no memory of where it left tab 2) is what hit the bug.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCondition(
      page,
      async () => {
        const s = await state();
        return s.window === firstTab && (s.panes ?? 0) >= 3;
      },
      20000,
      'the reloaded client to connect on the first tab with every pane known',
    );

    // Record every active pane the client passes through during the switch.
    await page.evaluate(() => {
      const seq = [window.app.getSnapshot().context.activePaneId];
      window.__paneSeq = seq;
      window.__paneSub = window.app.subscribe((snap) => {
        const id = snap.context.activePaneId;
        if (id !== seq[seq.length - 1]) seq.push(id);
      });
    });
    await ctrl('2');
    await waitForCondition(
      page,
      async () => (await state()).window === secondTab,
      8000,
      'the second tab to become current',
    );
    // Any late state the switch could still bring has landed once settled.
    await waitForSettled(page);
    const seq = await page.evaluate(() => {
      window.__paneSub?.unsubscribe();
      return window.__paneSeq;
    });
    // Straight from the first tab's pane to tab 2's right pane: no visit to
    // its first pane on the way.
    const known = await page.evaluate(() =>
      window.app.getSnapshot().context.windows.map((w) => [w.id, w.activePaneId]),
    );
    expect({ seq, known, rightPane, leftPaneOfTab2: secondTabPanes[0] }).toEqual({
      seq: [seq[0], rightPane],
      known,
      rightPane,
      leftPaneOfTab2: secondTabPanes[0],
    });
  }, 60000);
});
