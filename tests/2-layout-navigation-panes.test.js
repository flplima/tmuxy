/**
 * Layout & Navigation E2E Tests (Marked Pane, Collapsible Panes & Split After Tab Switch)
 */

const {
  createTestContext,
  delay,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  sendPrefixCommand,
  createWindowKeyboard,
  nextWindowKeyboard,
  firstLevelRows,
  waitForLayoutSettled,
  waitForCondition,
} = require('./helpers/layout-helpers');

// ==================== Scenario 4d: Marked pane ====================

describe('Scenario 4d: Marked pane', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // tmux's marked pane (`select-pane -m`) used to be invisible in tmuxy. It now
  // travels on the wire as `#{pane_marked}` and says so three ways: MARKED at
  // the right of the pane's header, an outline on the pane, and a wash of the
  // theme's accent over its content — so it reads from across the screen and
  // not only by a 1px edge. The context menu can swap another pane with it,
  // and clearing the mark (`select-pane -M`) removes all of it.
  test('prefix m flags the pane → swap with marked from the menu → prefix M clears [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    const paneOrder = () => ctx.session.query("list-panes -F '#{pane_id} #{pane_left}'");
    const markedInTmux = async () => {
      const out = await ctx.session.query("list-panes -F '#{pane_id} #{pane_marked}'");
      return String(out)
        .split('\n')
        .filter((l) => l.endsWith(' 1'))
        .map((l) => l.split(' ')[0]);
    };
    const markedInUi = () =>
      ctx.page.evaluate(() => {
        const badge = document.querySelector('[data-testid="pane-header-mark"]');
        const box = badge?.getBoundingClientRect();
        const marked = document.querySelector('.pane-layout-item.pane-marked');
        const content = marked?.querySelector('.pane-content');
        // The wash is a pseudo-element, so it is read off the computed style
        // rather than found in the DOM.
        const wash = content ? getComputedStyle(content, '::after') : null;
        return {
          state: (window.app?.getSnapshot()?.context?.panes || [])
            .filter((p) => p.marked)
            .map((p) => p.tmuxId),
          flags: document.querySelectorAll('[data-testid="pane-header-mark"]').length,
          outlined: document.querySelectorAll('.pane-layout-item.pane-marked').length,
          // Spelled out, and really drawn — a badge with no box says nothing.
          badgeText: badge?.textContent?.trim() ?? null,
          badgeVisible: Boolean(box && box.width > 20 && box.height > 5),
          // ...and on the RIGHT of its header, past its title.
          badgeRightOfTitle: Boolean(
            box &&
            box.left >
              (badge
                .closest('.pane-header')
                ?.querySelector('.pane-tab-title')
                ?.getBoundingClientRect().right ?? Infinity),
          ),
          washOpacity: wash ? Number(wash.opacity) : null,
          washColor: wash ? wash.backgroundColor : null,
        };
      });

    // Step 1: mark the active (right) pane.
    const rightPane = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    await sendPrefixCommand(ctx.page, 'm');
    await waitForCondition(
      ctx.page,
      async () => (await markedInUi()).state.join() === rightPane,
      8000,
      'the marked flag to reach the UI',
    );
    expect(await markedInTmux()).toEqual([rightPane]);
    const ui = await markedInUi();
    expect(ui.flags).toBe(1);
    expect(ui.outlined).toBe(1);
    expect(ui.badgeText).toMatch(/^MARKED/);
    expect(ui.badgeVisible).toBe(true);
    expect(ui.badgeRightOfTitle).toBe(true);
    // The wash is faint on purpose — it marks the pane, it does not take it
    // over — and it is the theme's accent, not a hardcoded colour.
    expect(ui.washOpacity).toBeGreaterThan(0);
    expect(ui.washOpacity).toBeLessThan(0.25);
    const accent = await ctx.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--theme-accent').trim(),
    );
    expect(accent).not.toBe('');
    expect(ui.washColor).not.toBe('rgba(0, 0, 0, 0)');

    // Step 2: from the OTHER pane's context menu, swap it with the marked pane.
    const orderBefore = String(await paneOrder());
    await navigatePaneKeyboard(ctx.page, 'left');
    const leftPane = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(leftPane).not.toBe(rightPane);
    // The pane menu lives behind the header's ⋮ button (a right-click on the
    // content opens the text-selection menu instead).
    await ctx.page.click(`.pane-container [data-pane-id="${leftPane}"] .pane-header-menu`);
    await ctx.page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    const swapItem = await ctx.page.$('[role="menuitem"]:has-text("Swap with Marked Pane")');
    expect(swapItem).not.toBeNull();
    await swapItem.click();
    await waitForCondition(
      ctx.page,
      async () => String(await paneOrder()) !== orderBefore,
      8000,
      'swap-pane with the marked pane to reorder the panes',
    );

    // Step 3: prefix M clears the mark everywhere.
    await sendPrefixCommand(ctx.page, 'M', { shift: true });
    await waitForCondition(
      ctx.page,
      async () => (await markedInUi()).state.length === 0,
      8000,
      'the mark to clear in the UI',
    );
    expect(await markedInTmux()).toEqual([]);
    const cleared = await markedInUi();
    expect(cleared.flags).toBe(0);
    expect(cleared.outlined).toBe(0);
  }, 120000);
});

// ==================== Scenario 4f: Collapsible panes ====================

describe('Scenario 4f: Collapsible panes', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // PANE mode's s turns the window collapsible and adds a first-level row:
  // only the row holding the active pane stays expanded, the others collapse
  // to one line per pane. Nested panes inside a row are never touched. S turns
  // it off and evens the first-level rows out (docs/TMUX.md, "Collapsible
  // panes").
  test('PANE mode s ×2 collapses the other rows → nested split + nav leaves the first level alone → ctrl+k expands a row → PANE mode S evens out', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // First-level row heights from tmux's own layout string; null when the
    // root is not a vertical stack.
    const rows = async () =>
      firstLevelRows(
        await ctx.session.runCommand(
          `display-message -p -t ${ctx.session.name} '#{window_layout}'`,
        ),
      );
    const collapsible = async () =>
      String(
        await ctx.session.runCommand(
          `show-options -wqv -t ${ctx.session.name}: @tmuxy-collapsible`,
        ),
      ).trim() === '1';
    // A collapsed pane keeps its header and drops its terminal (TerminalPane
    // renders no content for a one-row pane); the header must still be visible.
    const headerOnly = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.pane-layout-item')].map((el) => {
          const header = el.querySelector('.pane-header')?.getBoundingClientRect();
          return {
            paneId: el.querySelector('[data-pane-id]')?.dataset.paneId,
            collapsed: el.querySelector('.terminal-container') === null,
            headerVisible: Boolean(header && header.width > 20 && header.height > 8),
          };
        }),
      );

    // Step 1: PANE mode's s twice → three first-level rows, only the newest
    // expanded. The mode is sticky, so the second s needs no prefix; esc
    // leaves it.
    await sendPrefixCommand(page, 'p');
    await page.keyboard.press('s');
    await waitForPaneCount(page, 2);
    await page.keyboard.press('s');
    await waitForPaneCount(page, 3);
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => {
        const r = await rows();
        return r !== null && r.length === 3 && r[0] <= 2 && r[1] <= 2 && r[2] > 5;
      },
      10000,
      async () => `the first two rows to collapse (rows: ${JSON.stringify(await rows())})`,
    );
    expect(await collapsible()).toBe(true);
    // The collapsed rows render as headers only; the expanded one does not.
    await waitForCondition(
      page,
      async () => {
        const panes = await headerOnly();
        return (
          panes.length === 3 &&
          panes.filter((p) => p.collapsed).length === 2 &&
          panes.every((p) => p.headerVisible)
        );
      },
      8000,
      'two header-only panes in the DOM',
    );

    // Step 2: split the expanded row side by side and navigate inside it: the
    // first-level heights do not change.
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 4);
    const before = await rows();
    expect(before.length).toBe(3);
    // Each move has landed when the active pane changed; the first level must
    // not have moved with it.
    const active = () => page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId);
    for (const direction of ['left', 'right']) {
      const from = await active();
      await navigatePaneKeyboard(page, direction);
      await waitForCondition(
        page,
        async () => (await active()) !== from,
        8000,
        `the move ${direction} to change the active pane`,
      );
      await waitForLayoutSettled(page);
      expect(await rows()).toEqual(before);
    }

    // Step 3: moving up into a collapsed row expands it and collapses the
    // row that held the nested pair.
    await navigatePaneKeyboard(page, 'up');
    await waitForCondition(
      page,
      async () => {
        const r = await rows();
        return r !== null && r[1] > 5 && r[2] <= 2;
      },
      10000,
      async () => `the middle row to expand (rows: ${JSON.stringify(await rows())})`,
    );

    // Step 4: PANE mode's S turns the feature off and evens the rows out.
    await sendPrefixCommand(page, 'p');
    await page.keyboard.press('Shift+S');
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => {
        const r = await rows();
        if (r === null || r.length !== 3) return false;
        const max = Math.max(...r);
        const min = Math.min(...r);
        // …and no row is still drawn as a header alone: the client takes
        // the flag off a beat after tmux evens the rows.
        return (
          max - min <= 2 &&
          !(await collapsible()) &&
          (await headerOnly()).every((p) => !p.collapsed)
        );
      },
      10000,
      async () => `the rows to even out (rows: ${JSON.stringify(await rows())})`,
    );
  }, 150000);
});

// ==================== Scenario 4b: Split right after a tab switch ====================

describe('Scenario 4b: Split right after a tab switch', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The tab switch is optimistic: the client is on the new tab before tmux is.
  // A split fired in that gap used to land in the tab the user just LEFT,
  // because the binding was pinned with `select-pane` only, which never changes
  // tmux's current window. Every binding is now pinned to the visible window
  // too, so the split must follow the eye every time.
  test('prefix % immediately after ctrl+N / tab click / prefix n always splits the visible tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);

    const panesByWindow = async () => {
      const counts = {};
      const out = await ctx.session.query("list-panes -s -F '#{window_id}'");
      for (const line of String(out).split('\n')) {
        if (line) counts[line] = (counts[line] || 0) + 1;
      }
      return counts;
    };
    const visibleWindow = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);

    // The two tabs' tmux indices, for the ctrl+<digit> root bindings.
    const indices = await ctx.page.evaluate(() =>
      (window.app?.getSnapshot()?.context?.windows || [])
        .filter((w) => w.windowType === 'tab')
        .map((w) => w.index),
    );
    const ctrlDigit = async (digit) => {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press(String(digit));
      await ctx.page.keyboard.up('Control');
    };
    const switches = [
      () => ctrlDigit(indices[0]),
      () => ctrlDigit(indices[1]),
      () => ctx.page.click('.tab-name:nth-child(1)'),
      () => ctx.page.click('.tab-name:nth-child(2)'),
      () => nextWindowKeyboard(ctx.page),
      () => nextWindowKeyboard(ctx.page),
    ];
    for (let i = 0; i < switches.length; i++) {
      const before = await panesByWindow();
      await switches[i]();
      // No settling delay on purpose: this is the race. `%` is Shift+5, `"` is Shift+'.
      await sendPrefixCommand(ctx.page, i % 2 === 0 ? '5' : "'", { shift: true });
      const shown = await visibleWindow();
      await waitForCondition(
        ctx.page,
        async () => ((await panesByWindow())[shown] || 0) === (before[shown] || 0) + 1,
        8000,
        `iteration ${i}: the new pane to be in the visible window ${shown}`,
      );
      const after = await panesByWindow();
      for (const win of Object.keys(after)) {
        if (win !== shown) {
          expect({ iteration: i, window: win, panes: after[win] }).toEqual({
            iteration: i,
            window: win,
            panes: before[win] || 0,
          });
        }
      }
    }
  }, 120000);
});
