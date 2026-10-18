/**
 * Layout & Navigation E2E Tests (Tab Overview & Window Lifecycle)
 */

const {
  createTestContext,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  openSidebarKeyboard,
  createWindowKeyboard,
  pressUntilWindowChanged,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
  selectLayoutKeyboard,
  assertLayoutInvariants,
  waitForLayoutSettled,
  waitForCondition,
} = require('./helpers/layout-helpers');

// ==================== Scenario 4e: Tab Overview and ctrl+N by position ====================

describe('Scenario 4e: Tab Overview and ctrl+N by position', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // ctrl+0 zooms the current tab out into a grid of every tab (Safari's tab
  // overview): click a slot to switch, "+" creates, ✕ closes, drag reorders,
  // Escape restores. ctrl+1…9 pick a tab by its POSITION in the strip — a
  // sidebar window occupying a tmux index must never shift which tab a digit
  // lands on.
  test('ctrl+0 shows every tab; click, +, ✕ and drag act on the strip; ctrl+3 picks the third visible tab', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    const state = () =>
      page.evaluate(() => {
        const c = window.app?.getSnapshot()?.context;
        const tabs = (c?.windows || [])
          .filter((w) => w.windowType === 'tab')
          .sort((a, b) => a.index - b.index)
          .map((w) => ({ id: w.id, index: w.index }));
        return { tabs, active: c?.activeWindowId, chrome: (c?.windows || []).length - tabs.length };
      });
    const overview = () =>
      page.evaluate(() => {
        const o = document.querySelector('[data-testid="tab-overview"]');
        if (!o) return null;
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const layout = document.querySelector('.pane-layout');
        return {
          slots: [...o.querySelectorAll('[data-testid^="tab-overview-slot-"]')].map((el) => ({
            id: el.dataset.testid.replace('tab-overview-slot-', ''),
            active: el.classList.contains('is-active'),
            rect: box(el),
            close: box(el.querySelector('.tab-overview-slot-close')),
            frame: box(el.querySelector('.tab-overview-frame')),
          })),
          plus: box(o.querySelector('[data-testid="tab-overview-new"]')),
          layout: box(layout),
          transform: getComputedStyle(layout).transform,
        };
      });
    const ctrl = async (key) => {
      await page.keyboard.down('Control');
      await page.keyboard.press(key);
      await page.keyboard.up('Control');
    };
    const clickAt = (r) => page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
    const waitOverview = (open) =>
      waitForCondition(
        page,
        async () => ((await overview()) !== null) === open,
        8000,
        `the tab overview to ${open ? 'open' : 'close'}`,
      );

    const inside = (a, b) =>
      a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
    // ctrl+0, then wait for the zoom-out transition to settle: the live grid
    // must sit inside the current tab's frame before anything is clicked.
    const openOverview = async () => {
      await ctrl('0');
      await waitOverview(true);
      await waitForCondition(
        page,
        async () => {
          const o = await overview();
          const slot = o?.slots.find((s) => s.active);
          return Boolean(slot) && inside(o.layout, slot.frame);
        },
        8000,
        'the pane grid to zoom into its slot',
      );
    };

    // Leave a marker on the first tab's screen; the overview, opened later from
    // the third tab, must show that screen in the first tab's slot.
    const marker = `overview-still-${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressEnter(page);
    await waitForTerminalText(page, marker, 10000);
    const markedPane = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.panes.find((p) => p.active)?.tmuxId,
    );
    expect(markedPane).toMatch(/^%\d+$/);

    // A chrome window (the right sidebar) takes tmux index 2 BEFORE the tabs
    // that follow, so strip position and tmux index disagree from here on.
    await openSidebarKeyboard(page, 'right', { fixed: true });
    await waitForCondition(page, async () => (await state()).chrome >= 1, 8000, 'the dock window');
    await createWindowKeyboard(page);
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 3);
    const three = await state();
    expect(three.tabs.map((t) => t.index)).not.toEqual([1, 2, 3]);

    // Step 1: ctrl+0 opens the overview — one slot per tab, the "+" slot, and
    // the live pane grid scaled INTO the current tab's frame.
    await openOverview();
    let ov = await overview();
    expect(ov.slots.map((s) => s.id)).toEqual(three.tabs.map((t) => t.id));
    expect(ov.plus.w).toBeGreaterThan(50);
    expect(ov.transform).not.toBe('none');
    const activeSlot = ov.slots.find((s) => s.active);
    expect(activeSlot.id).toBe(three.active);

    // The first tab's slot shows the marker — a rendered terminal, drawn
    // inside the slot's frame rather than off somewhere at full size.
    const slotText = (tabId) =>
      page.evaluate((id) => {
        const slot = document.querySelector(`[data-testid="tab-overview-slot-${id}"]`);
        const shot = slot?.querySelector('.tab-overview-shot');
        if (!shot) return null;
        const f = slot.querySelector('.tab-overview-frame').getBoundingClientRect();
        const r = shot.getBoundingClientRect();
        return {
          text: shot.textContent,
          inFrame:
            r.left >= f.left - 1 &&
            r.right <= f.right + 1 &&
            r.top >= f.top - 1 &&
            r.bottom <= f.bottom + 1,
        };
      }, tabId);
    await waitForCondition(
      page,
      async () => (await slotText(three.tabs[0].id))?.text.includes(marker),
      8000,
      "the first tab's slot to show its screen",
    );
    expect((await slotText(three.tabs[0].id)).inFrame).toBe(true);

    // It is a STILL: output that arrives while the overview is open does not
    // reach the slot, though the live pane has it.
    const later = `${marker}-later`;
    await ctx.session.runCommand(`send-keys -t ${markedPane} 'echo ${later}' Enter`);
    await waitForCondition(
      page,
      () =>
        page.evaluate(
          ({ id, text }) =>
            window.app
              ?.getSnapshot()
              ?.context?.panes.find((p) => p.tmuxId === id)
              ?.content.some((line) =>
                line
                  .map((c) => c.c)
                  .join('')
                  .includes(text),
              ),
          { id: markedPane, text: later },
        ),
      10000,
      'the later echo to reach the live pane',
    );
    expect((await slotText(three.tabs[0].id)).text).not.toContain(later);

    // The header's grid button is the same toggle: it closes the overview and
    // opens it again (a fresh still, which now has the later line).
    const gridButton = () => page.$('[data-testid="tab-overview-toggle"]');
    await (await gridButton()).click();
    await waitOverview(false);
    await (await gridButton()).click();
    await waitOverview(true);
    await waitForCondition(
      page,
      async () => (await slotText(three.tabs[0].id))?.text.includes(later),
      8000,
      'the reopened overview to show the fresh still',
    );
    await waitForCondition(
      page,
      async () => {
        const o = await overview();
        const slot = o?.slots.find((s) => s.active);
        return Boolean(slot) && inside(o.layout, slot.frame);
      },
      8000,
      'the pane grid to zoom into its slot again',
    );
    ov = await overview();

    // Step 2: clicking the first slot switches to that tab and closes the overview.
    await clickAt(ov.slots[0].rect);
    await waitOverview(false);
    await waitForCondition(
      page,
      async () => (await state()).active === three.tabs[0].id,
      8000,
      'the first tab to become current',
    );
    expect(await overview()).toBeNull();
    await waitForCondition(
      page,
      () =>
        page.evaluate(
          () => getComputedStyle(document.querySelector('.pane-layout')).transform === 'none',
        ),
      8000,
      'the pane grid to zoom back to full size',
    );

    // Step 3: "+" creates a tab.
    await openOverview();
    await clickAt((await overview()).plus);
    await waitForWindowCount(page, 4);
    await waitOverview(false);
    // The strip shows the new tab optimistically first; wait for tmux's @id.
    await waitForCondition(
      page,
      async () => (await state()).tabs.every((t) => t.id.startsWith('@')),
      8000,
      'the new tab to get its tmux id',
    );

    // Step 4: the ✕ on the last slot closes that tab; the overview stays open.
    await openOverview();
    ov = await overview();
    const doomed = ov.slots[3].id;
    await page.mouse.move(ov.slots[3].rect.x + 20, ov.slots[3].rect.y + 20);
    await clickAt(ov.slots[3].close);
    await waitForWindowCount(page, 3);
    await waitForCondition(
      page,
      async () => !(await overview())?.slots.some((s) => s.id === doomed),
      8000,
      'the closed tab to leave the overview',
    );

    // Step 5: drag the first slot (the CURRENT tab's) to between the other two
    // → it becomes the middle tab, in the strip AND in tmux, with every index
    // renumbered (a drop in the middle shifts the tabs behind it; a stale index
    // would leave two tabs claiming one position).
    ov = await overview();
    const dragged = ov.slots[0].id;
    expect(ov.slots[0].active).toBe(true);
    const from = ov.slots[0].rect;
    const between = ov.slots[2].rect;
    await page.mouse.move(from.x + from.w / 2, from.y + from.h / 2);
    await page.mouse.down();
    await page.mouse.move(between.x - 20, between.y + between.h / 2, { steps: 12 });
    // Mid-drag: the live pane grid rides along inside the dragged card (the
    // card's move is a React render away from the last pointer event).
    const midDrag = () =>
      page.evaluate(() => {
        const card = document.querySelector('.tab-overview-slot.is-dragging');
        if (!card) return null;
        const f = card.querySelector('.tab-overview-frame').getBoundingClientRect();
        const g = document.querySelector('.pane-layout').getBoundingClientRect();
        const box = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
        return { dragging: card.dataset.windowId, frame: box(f), grid: box(g) };
      });
    await waitForCondition(
      page,
      async () => {
        const d = await midDrag();
        return d?.dragging === dragged && inside(d.grid, d.frame);
      },
      3000,
      'the live grid to ride inside the dragged card',
    );
    await page.mouse.up();
    await waitForCondition(
      page,
      async () => {
        const tabs = (await state()).tabs;
        return tabs.length === 3 && tabs[1].id === dragged;
      },
      8000,
      'the dragged tab to become the middle one',
    );
    const tmuxOrder = String(await ctx.session.query("list-windows -F '#{window_id}'"))
      .split('\n')
      .filter((id) => ov.slots.some((s) => s.id === id));
    expect(tmuxOrder[1]).toBe(dragged);
    // The client's strip order is tmux's, with distinct indices all round.
    const clientTabs = (await state()).tabs;
    expect(clientTabs.map((t) => t.id)).toEqual(tmuxOrder);
    expect(new Set(clientTabs.map((t) => t.index)).size).toBe(clientTabs.length);

    // Step 6: Escape restores the tab; ctrl+3 picks the THIRD visible tab even
    // though its tmux index is not 3.
    await page.keyboard.press('Escape');
    await waitOverview(false);
    await ctrl('1');
    const after = await state();
    await waitForCondition(
      page,
      async () => (await state()).active === after.tabs[0].id,
      8000,
      'ctrl+1',
    );
    await ctrl('3');
    await waitForCondition(
      page,
      async () => (await state()).active === after.tabs[2].id,
      8000,
      'ctrl+3',
    );
    expect(after.tabs[2].index).not.toBe(3);
  }, 150000);
});

// ==================== Scenario 4: Window Lifecycle ====================

describe('Scenario 4: Window Lifecycle', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('New window → tabs → next/prev → by-number → last → rename → close → layout', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Create new window
    const initialCount = await ctx.session.getWindowCount();
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, initialCount + 1);
    expect(await ctx.session.getWindowCount()).toBe(initialCount + 1);

    // Step 1b: Verify typing works in the new window.
    // After create-window (split-window + break-pane), the pane moves to a
    // new window. Output must not be dropped by the panes_moved_window flag.
    const NEW_WIN_TOKEN = 'NEW_WIN_' + Date.now();
    await runCommand(ctx.page, `echo ${NEW_WIN_TOKEN}`, NEW_WIN_TOKEN);

    // Step 2: Window tabs
    const windowInfo = await ctx.session.getWindowInfo();
    expect(windowInfo.length).toBe(2);

    // Step 3: Next window (keyboard only — no adapter fallback)
    await pressUntilWindowChanged(ctx, nextWindowKeyboard, 'next-window keyboard');

    // Step 4: Previous window (keyboard only)
    await pressUntilWindowChanged(ctx, prevWindowKeyboard, 'prev-window keyboard');

    // Step 5: Create 3rd window and select by number
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 3);
    await selectWindowKeyboard(ctx.page, 1);
    await waitForCondition(
      ctx.page,
      async () => {
        const curIdx = await ctx.session.getCurrentWindowIndex();
        return curIdx === '1';
      },
      10000,
      'select-window -t :1 to activate window 1',
    );

    // Step 6: Last window toggle (keyboard only)
    await pressUntilWindowChanged(ctx, lastWindowKeyboard, 'last-window keyboard');

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'MyRenamedWindow');
    await waitForCondition(
      ctx.page,
      async () => (await ctx.session.getWindowInfo()).some((w) => w.name === 'MyRenamedWindow'),
      8000,
      'tmux to report the renamed window',
    );
    let windows = await ctx.session.getWindowInfo();
    expect(windows.find((w) => w.name === 'MyRenamedWindow')).toBeDefined();

    // Step 8: Close windows until only 1 remains — through the real user
    // path (prefix + :kill-window kills the current window; tmux then
    // focuses another, so repeating converges). The old version called
    // _exec('kill-window'), skipping the entire keyboard → machine → adapter
    // chain where close bugs live (TESTS.md: use real user paths).
    let winCount = await ctx.session.getWindowCount();
    while (winCount > 1) {
      await killWindowKeyboard(ctx.page);
      await waitForWindowCount(ctx.page, winCount - 1);
      winCount = await ctx.session.getWindowCount();
    }
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);

    // Step 9: Layout test with 4 panes
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2, 10000);
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 3, 10000);
    await navigatePaneKeyboard(ctx.page, 'up');
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 4, 10000);

    await selectLayoutKeyboard(ctx.page, 'tiled');
    // Tiled: four panes of about the same area, by tmux's own geometry.
    const evenAreas = async () => {
      const panes = await ctx.session.getPaneInfo();
      if (panes.length !== 4) return false;
      const areas = panes.map((p) => p.width * p.height);
      return Math.max(...areas) / Math.min(...areas) < 2;
    };
    await waitForCondition(ctx.page, evenAreas, 8000, 'tmux to tile the four panes evenly');

    // The layout change triggers a resize round-trip; let the grid land.
    await waitForLayoutSettled(ctx.page);

    // Verify layout invariants (overlap, centering, padding, headers, dimensions)
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 4 tiled layout' });
  }, 180000);
});
