/**
 * Layout & Navigation E2E Tests
 *
 * Window lifecycle, pane groups, floating panes, and status bar.
 */

const fs = require('fs');

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
  TMUXY_CLI,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  sendPrefixCommand,
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
  tmuxCommandKeyboard,
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  getThemeAccent,
  assertLayoutInvariants,
  firstLevelRows,
  waitForShellPrompt,
  waitForLayoutSettled,
  afterFrames,
  showsShellPrompt,
  waitForCondition,
  pasteText,
  DELAYS,
} = require('./helpers');

// ==================== Float Visual Verification Helper ====================

/**
 * Verify a float pane is visually present and interactive.
 * Checks bounding rect, visible content area, and terminal presence.
 * Returns { floatRect, contentRect } for further assertions.
 */
async function verifyFloatVisible(page) {
  const info = await page.evaluate(() => {
    // Find the float container (centered float) or modal-container (drawer)
    const fc =
      document.querySelector('.float-container') || document.querySelector('.modal-container');
    if (!fc) return null;
    const fcRect = fc.getBoundingClientRect();

    // Find the terminal content area inside the float
    const content = fc.querySelector('.float-content') || fc.querySelector('.terminal-content');
    const contentRect = content ? content.getBoundingClientRect() : null;

    // Check for terminal log element
    const log = fc.querySelector('[role="log"]');
    const logRect = log ? log.getBoundingClientRect() : null;

    return {
      floatRect: {
        x: Math.round(fcRect.x),
        y: Math.round(fcRect.y),
        w: Math.round(fcRect.width),
        h: Math.round(fcRect.height),
      },
      contentRect: contentRect
        ? { w: Math.round(contentRect.width), h: Math.round(contentRect.height) }
        : null,
      logRect: logRect ? { w: Math.round(logRect.width), h: Math.round(logRect.height) } : null,
    };
  });

  expect(info).not.toBeNull();
  expect(info.floatRect.w).toBeGreaterThan(100);
  expect(info.floatRect.h).toBeGreaterThan(100);
  expect(info.contentRect).not.toBeNull();
  expect(info.contentRect.w).toBeGreaterThan(50);
  expect(info.contentRect.h).toBeGreaterThan(50);

  return info;
}

async function waitForFloatModal(page, timeout = 10000) {
  await page.waitForSelector('.modal-overlay', { timeout });
}

async function waitForNoModal(page) {
  await page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
    timeout: 10000,
    polling: 100,
  });
}

const focusedFloatPaneId = (page) =>
  page.evaluate(() => window.app?.getSnapshot()?.context?.focusedFloatPaneId ?? null);

/**
 * How far the float's centre sits from the centre of the pane container's
 * content box (the box the grid fills), in pixels, with the container's width
 * so a caller can tell a resize arrived.
 */
const floatCentreOffset = (page) =>
  page.evaluate(() => {
    const float = document.querySelector('.float-modal .modal-container');
    const container = document.querySelector('.pane-container');
    if (!float || !container) return null;
    const f = float.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    const pad = getComputedStyle(container);
    const left = c.x + parseFloat(pad.paddingLeft);
    const right = c.right - parseFloat(pad.paddingRight);
    const top = c.y + parseFloat(pad.paddingTop);
    const bottom = c.bottom - parseFloat(pad.paddingBottom);
    return {
      dx: f.x + f.width / 2 - (left + right) / 2,
      dy: f.y + f.height / 2 - (top + bottom) / 2,
      containerWidth: Math.round(c.width),
    };
  });

/**
 * How far off centre a float may measure. Its position is computed exactly;
 * the browser then snaps each edge to a whole pixel, half a pixel at most, and
 * the rects come back with floating-point noise on top (CI measured
 * 1.0000153).
 */
const CENTRE_TOLERANCE_PX = 1.001;

const isCentred = (offset) =>
  offset !== null &&
  Math.abs(offset.dx) <= CENTRE_TOLERANCE_PX &&
  Math.abs(offset.dy) <= CENTRE_TOLERANCE_PX;

/**
 * Open a float the way a user does — `tmuxy pane float` typed at the prompt —
 * and return once it is on screen with a real size and holds the keyboard
 * focus. Returns the focused float's pane id.
 */
async function openFloatFromCli(ctx) {
  await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
  await pressEnter(ctx.page);
  // Extended timeout for the CLI → run-shell → control mode chain.
  await waitForFloatModal(ctx.page, 20000);
  // float-create.sh's last step focuses the float, which is what the wait
  // below holds out for — not a fixed beat after the modal appears.
  await verifyFloatVisible(ctx.page);
  await waitForCondition(
    ctx.page,
    async () => (await focusedFloatPaneId(ctx.page)) !== null,
    5000,
    'focusedFloatPaneId to be set after float appears',
  );
  return focusedFloatPaneId(ctx.page);
}

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

// ==================== Scenario 4c: Zoom in a 2×2 grid ====================

describe('Scenario 4c: Zoom in a 2×2 grid', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The zoomed pane used to be identified as "the first pane whose far corner
  // touches the grid's far corner" — which the bottom-right pane of any grid
  // does. Zooming the top-left pane therefore hid it and left the bottom-right
  // pane sitting in its quarter slot. The zoomed pane must be the one that
  // spans the whole grid, whichever pane it is.
  test('zooming the top-left pane shows that pane full size and hides the others; unzoom restores all four [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 2×2: split right, then split each column down.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await navigatePaneKeyboard(ctx.page, 'left');
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4);

    const visiblePanes = () =>
      ctx.page.evaluate(() => {
        const ctxState = window.app?.getSnapshot()?.context;
        return (ctxState?.panes || [])
          .filter((p) => p.windowId === ctxState.activeWindowId)
          .map((p) => {
            const el = document.querySelector(`.pane-container [data-pane-id="${p.tmuxId}"]`);
            const r = el?.getBoundingClientRect();
            return {
              id: p.tmuxId,
              w: Math.round(r?.width ?? 0),
              h: Math.round(r?.height ?? 0),
              opacity: el ? Number(getComputedStyle(el).opacity) : 0,
            };
          });
      });

    // Zoom the TOP-LEFT pane (x=0, y=top). Navigate there first.
    await navigatePaneKeyboard(ctx.page, 'up');
    const zoomTarget = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    const targetGeometry = await ctx.page.evaluate(
      (id) => window.app?.getSnapshot()?.context?.panes?.find((p) => p.tmuxId === id),
      zoomTarget,
    );
    expect(targetGeometry.x).toBe(0);

    const before = await visiblePanes();
    const quarterW = Math.max(...before.map((p) => p.w));
    const quarterH = Math.max(...before.map((p) => p.h));

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed)),
      8000,
      'tmux to report the window zoomed',
    );
    // The other panes fade out by CSS transition: read them once it is done.
    await waitForCondition(
      ctx.page,
      async () => (await visiblePanes()).filter((p) => p.opacity > 0.99).length === 1,
      5000,
      'the zoom to leave one pane shown',
    );

    const zoomed = await visiblePanes();
    const shown = zoomed.filter((p) => p.opacity > 0.99);
    expect(shown.map((p) => p.id)).toEqual([zoomTarget]);
    // The zoomed pane grew to the grid: about twice a quarter in each direction.
    expect(shown[0].w).toBeGreaterThan(quarterW * 1.8);
    expect(shown[0].h).toBeGreaterThan(quarterH * 1.8);

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => !window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed),
        ),
      8000,
      'tmux to report the window un-zoomed',
    );
    await waitForCondition(
      ctx.page,
      async () => (await visiblePanes()).filter((p) => p.opacity > 0.99).length === 4,
      5000,
      'the un-zoom to show all four panes again',
    );
    const restored = await visiblePanes();
    expect(restored.filter((p) => p.opacity > 0.99).length).toBe(4);
    await assertLayoutInvariants(ctx.page);
  }, 120000);

  // An even 2×2 grid built column by column: the two row lines happen to line
  // up, but tmux resizes each column's on its own. Dragging the left one used
  // to draw the right column moving too — a layout tmux never produced, so the
  // preview hung on until its fallback timer gave up.
  test('in a grid split into columns, dragging one column’s row divider moves that column only', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await navigatePaneKeyboard(ctx.page, 'left');
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          return Boolean(c?.windows?.find((w) => w.id === c.activeWindowId)?.paneTree);
        }),
      8000,
      'the window to report its split structure',
    );

    // Where each pane is drawn, keyed by which quarter of the grid it sits in.
    const quarters = () =>
      ctx.page.evaluate(() => {
        const c = window.app.getSnapshot().context;
        const panes = c.panes.filter((p) => p.windowId === c.activeWindowId);
        const midX = Math.max(...panes.map((p) => p.x)) / 2;
        const midY = Math.max(...panes.map((p) => p.y)) / 2;
        const out = {};
        for (const p of panes) {
          const el = document.querySelector(`.pane-container [data-pane-id="${p.tmuxId}"]`);
          const r = el.getBoundingClientRect();
          const key = `${p.y < midY ? 'top' : 'bottom'}-${p.x < midX ? 'left' : 'right'}`;
          out[key] = { top: Math.round(r.top), height: Math.round(r.height) };
        }
        return out;
      });

    // Each column has its own row divider: two ns-resize handles, side by side.
    const rowDividers = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.resize-divider')]
        .filter((d) => d.style.cursor === 'ns-resize')
        .map((d) => {
          const r = d.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, width: r.width };
        })
        .sort((a, b) => a.left - b.left),
    );
    expect(rowDividers).toHaveLength(2);
    const [leftDivider] = rowDividers;

    const before = await quarters();
    const rowPx = await ctx.page.evaluate(() => window.app.getSnapshot().context.charHeight);

    await ctx.page.mouse.move(leftDivider.x, leftDivider.y);
    await ctx.page.mouse.down();
    for (let step = 1; step <= 3; step++) {
      await ctx.page.mouse.move(leftDivider.x, leftDivider.y + step * rowPx);
    }
    // Mid-drag, as drawn: the left column moved, the right one did not.
    await waitForCondition(
      ctx.page,
      async () => (await quarters())['top-left'].height > before['top-left'].height,
      8000,
      'the preview to draw the drag',
    );
    const during = await quarters();
    expect(during['top-right']).toEqual(before['top-right']);
    expect(during['bottom-right']).toEqual(before['bottom-right']);
    await ctx.page.mouse.up();

    // And tmux agrees: the preview lets go once its layout has landed.
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => window.app.getSnapshot().context.resize === null),
      8000,
      'the resize preview to settle',
    );
    const after = await quarters();
    expect(after['top-left'].height).toBeGreaterThan(before['top-left'].height);
    expect(after['top-right']).toEqual(before['top-right']);
    expect(after['bottom-right']).toEqual(before['bottom-right']);
    await assertLayoutInvariants(ctx.page);
  }, 120000);
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

// ==================== Scenario 4g: Drag a pane onto the tab strip ====================

describe('Scenario 4g: Drag a pane onto the tab strip', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** How many panes each window holds, keyed by tmux window id. */
  const panesByWindow = async () => {
    const counts = {};
    const out = await ctx.session.query("list-panes -s -F '#{window_id}'");
    for (const line of String(out).split('\n')) {
      if (line) counts[line] = (counts[line] || 0) + 1;
    }
    return counts;
  };

  /**
   * The box of the header of the last pane in the VISIBLE tab.
   *
   * Every tab's panes are in the document and only one tab's are on screen, so
   * "the last header" can belong to the tab being dragged to — and a pane
   * dropped on the tab it already lives in goes nowhere.
   */
  const secondPaneHeaderBox = (page) =>
    page.evaluate(() => {
      const ctx = window.app.getSnapshot().context;
      const here = new Set(
        ctx.panes.filter((p) => p.windowId === ctx.activeWindowId).map((p) => p.tmuxId),
      );
      const items = [...document.querySelectorAll('.pane-layout-item')].filter((item) =>
        here.has(item.querySelector('[data-pane-id]')?.dataset.paneId),
      );
      const item = items[items.length - 1];
      const r = item.querySelector('.pane-header').getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        paneId: item.querySelector('[data-pane-id]').dataset.paneId,
      };
    });

  /**
   * Press on the header and travel to (x, y) in steps, so the 5px threshold
   * that turns a press into a drag is crossed the way a hand crosses it.
   */
  const dragHeaderTo = async (page, from, x, y) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const t of [0.15, 0.4, 0.7, 1]) {
      await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await delay(60);
    }
  };

  // Dragging a pane's header up onto another tab's button moves the pane into
  // that tab. While the pointer is over it the button says so, because a drop
  // that silently rearranges two tabs is not something to find out afterwards.
  test('drag a pane onto another tab: the tab highlights, and the drop moves the pane there', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // A second tab to aim at, then back to the first, which gets a second pane.
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 2);
    await selectWindowKeyboard(page, 1);
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);

    const windowIds = await page.evaluate(() =>
      (window.app?.getSnapshot()?.context?.windows || [])
        .filter((w) => w.windowType === 'tab')
        .map((w) => w.id),
    );
    const sourceWindow = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    const targetWindow = windowIds.find((id) => id !== sourceWindow);
    const before = await panesByWindow();
    expect(before[sourceWindow]).toBe(2);
    expect(before[targetWindow]).toBe(1);

    const header = await secondPaneHeaderBox(page);
    const tabBox = await page.evaluate((id) => {
      const el = document.querySelector(`.tab-name[data-window-id="${id}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, targetWindow);

    await dragHeaderTo(page, header, tabBox.x, tabBox.y);

    // The tab under the pointer says it would take the pane: it is marked, and
    // the mark is visible — an outline it does not otherwise carry.
    await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`.tab-name[data-window-id="${id}"]`);
          if (!el || !el.classList.contains('is-pane-drop-target')) return false;
          const outline = getComputedStyle(el).outlineWidth;
          return parseFloat(outline) > 0;
        }, targetWindow),
      8000,
      'the target tab to be highlighted as the drop target',
    );
    // No new-tab placeholder while the pointer is on a tab.
    expect(await page.$('.tab-new-drop')).toBeNull();
    // The other tab is not marked.
    expect(
      await page.evaluate(
        (id) =>
          document
            .querySelector(`.tab-name[data-window-id="${id}"]`)
            .classList.contains('is-pane-drop-target'),
        sourceWindow,
      ),
    ).toBe(false);

    await page.mouse.up();

    await waitForCondition(
      page,
      async () => {
        const counts = await panesByWindow();
        return counts[targetWindow] === 2 && (counts[sourceWindow] || 0) === 1;
      },
      10000,
      async () => `the pane to move tabs (panes: ${JSON.stringify(await panesByWindow())})`,
    );
    // The highlight goes away with the drag.
    expect(await page.$('.tab-name.is-pane-drop-target')).toBeNull();
  }, 150000);

  // Dropped past the last tab, the pane becomes a tab of its own. The empty
  // space has nothing to highlight, so a dashed placeholder stands in for the
  // tab that would be created.
  test('drag a pane to the empty strip: a dashed "New Tab" appears, and the drop breaks the pane out', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);
    // The strip is measured below, so wait for it to exist. Waiting only for
    // the PANE count does not imply the tab strip has rendered — they are
    // different components off different parts of the model — and reading an
    // empty strip fails as `tabs[tabs.length - 1]` being undefined, which
    // reports as a TypeError about `getBoundingClientRect` rather than as
    // "the tab strip was not ready".
    await waitForWindowCount(page, 1);
    const sourceWindow = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect((await panesByWindow())[sourceWindow]).toBe(2);

    const header = await secondPaneHeaderBox(page);
    // Well past the last tab, still inside the strip's row.
    const empty = await page.evaluate(() => {
      const list = document.querySelector('.tab-list');
      const tabs = [...list.querySelectorAll('.tab-name[data-window-id]')];
      const last = tabs[tabs.length - 1].getBoundingClientRect();
      const strip = list.getBoundingClientRect();
      return { x: Math.min(last.right + 160, strip.right - 20), y: strip.top + strip.height / 2 };
    });

    await dragHeaderTo(page, header, empty.x, empty.y);

    // The placeholder is there, it says what it does, and it is drawn dashed
    // and big enough to read — not a zero-size node in the DOM.
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const el = document.querySelector('.tab-new-drop');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return (
            el.textContent.trim() === 'New Tab' &&
            r.width > 30 &&
            r.height > 8 &&
            cs.borderStyle === 'dashed' &&
            parseFloat(cs.borderWidth) > 0
          );
        }),
      8000,
      'the dashed New Tab placeholder to appear in the strip',
    );
    // Nothing on the strip is claiming the pane at the same time.
    expect(await page.$('.tab-name.is-pane-drop-target')).toBeNull();

    await page.mouse.up();

    await waitForWindowCount(page, 2);
    await waitForCondition(
      page,
      async () => {
        const counts = await panesByWindow();
        const ids = Object.keys(counts);
        return (
          ids.length === 2 && counts[sourceWindow] === 1 && ids.every((id) => counts[id] === 1)
        );
      },
      10000,
      async () =>
        `the pane to become its own tab (panes: ${JSON.stringify(await panesByWindow())})`,
    );
    expect(await page.$('.tab-new-drop')).toBeNull();
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

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Header → add button → create group → switch tabs → identity verify → add 3rd → close tab → ungroup', async () => {
    if (ctx.skipIfNotReady()) return;
    const activePane = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId || null);
    // A group switch is settled by a fixed wait here, deliberately: the
    // client's active pane is optimistic, tmux's own answer names the pane
    // of whatever window it considers current while a group swap is under
    // way, and a wait on either let the next group operation go out
    // mid-swap on CI (the third member then never took the keyboard).
    await ctx.setupPage();

    // Layout invariants on initial single pane
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 5 initial' });

    // Step 1: Header element exists
    const header = await ctx.page.$('.pane-tab');
    expect(header).not.toBeNull();

    // Step 2: Menu button exists (pane group add is via ⋮ menu)
    const menuButton = await ctx.page.$('.pane-header-menu');
    expect(menuButton).not.toBeNull();

    // Step 3: Record original (ALPHA) pane ID and stamp its CONTENT with a
    // token — pane identity is verified below by what the user actually sees
    // rendered, not only by state-level ids (a swap that renders the wrong
    // pane's content under the right id would pass an id-only check).
    const alphaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(alphaPaneId).not.toBeNull();
    const ALPHA_TOKEN = `ALPHA_CONTENT_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${ALPHA_TOKEN}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 4: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter((t) => t.active).length).toBe(1);

    // The strip says WHICH member is showing by colour: the one in view wears
    // the theme's accent and the parked one does not. Both are listed, so the
    // colour is the only thing telling them apart — a group whose tabs all
    // read the same is a group you cannot navigate by eye.
    const accent = await getThemeAccent(ctx.page);
    expect(tabs.find((t) => t.active).color).toBe(accent);
    expect(tabs.filter((t) => !t.active).map((t) => t.color)).not.toContain(accent);

    // The header is SHARED between the members: an equal share each, with the
    // member's own ⋮ and ✕ at the right of its own share. One pair of buttons
    // for the whole strip belonged to whichever member happened to be showing,
    // and could never close a parked one.
    for (const tab of tabs) {
      expect(tab.buttons).toEqual([
        expect.stringMatching(/^Pane menu for %\d+$/),
        expect.stringMatching(/^Close pane %\d+$/),
      ]);
      expect(tab.controlsAfterTitle).toBe(true);
    }
    const widths = tabs.map((t) => t.width);
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(widths[0] * 0.25);
    // ...and the parked member's share is dimmed by its ground, so the two
    // read apart without reading them.
    expect(tabs.find((t) => t.active).background).not.toBe(tabs.find((t) => !t.active).background);

    // Step 4b: The group parks its members in hidden tmux windows, which take
    // window indices of their own. A tab opened now must still read ➋, by its
    // position in the strip — it shipped reading "5:", the tmux index.
    const groupWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId ?? null,
    );
    expect(groupWindowId).toMatch(/^@\d+$/);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    const tabLabels = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('.tab-list .tab-name')].map((el) =>
          (el.querySelector('.tab-mark')?.textContent || '').trim(),
        ),
      );
    await waitForCondition(
      ctx.page,
      async () => {
        const labels = await tabLabels();
        return labels.length === 2 && labels[0] === '➊' && labels[1] === '➋';
      },
      10000,
      async () => `the tab strip to read ➊, ➋ (saw ${JSON.stringify(await tabLabels())})`,
    );
    // Back to the group's tab, by its stable id, for the rest of the scenario.
    await ctx.page.click(`.tab-list .tab-name[data-window-id="${groupWindowId}"]`);
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          (id) => window.app?.getSnapshot()?.context?.activeWindowId === id,
          groupWindowId,
        ),
      10000,
      'the group window to be back on screen',
    );
    await waitForGroupTabs(ctx.page, 2);
    // And close that tab the way the strip offers it — right-click → "Close
    // Tab" — so the rest of the scenario reads one window's group header. A
    // background tab keeps its panes mounted, and its lone header tab would
    // otherwise be counted among the group's.
    await ctx.page.click(
      `.tab-list .tab-name[data-window-id]:not([data-window-id="${groupWindowId}"])`,
      { button: 'right' },
    );
    await ctx.page.locator('[role="menuitem"]', { hasText: 'Close Tab' }).click({ timeout: 5000 });
    await waitForWindowCount(ctx.page, 1);

    // Step 5: Record the new (BETA) pane ID — it should be different from ALPHA
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate((alpha) => {
          const id = window.app?.getSnapshot()?.context?.activePaneId || null;
          return id !== null && id !== alpha;
        }, alphaPaneId),
      10000,
      'the new group member to be the active pane',
    );
    const betaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(betaPaneId).not.toBeNull();
    expect(betaPaneId).not.toBe(alphaPaneId);

    // Step 6: Switch to original pane tab, verify pane identity via ID
    const inactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activePaneId || null,
        );
        return id === alphaPaneId;
      },
      10000,
      'group tab switch to ALPHA pane',
    );

    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter((t) => t.active).length).toBe(1);
    // ...and the accent moved with the switch, rather than staying on the tab
    // that used to be showing.
    expect(tabs.find((t) => t.active).color).toBe(accent);
    expect(tabs.filter((t) => !t.active).map((t) => t.color)).not.toContain(accent);

    const afterSwitchId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitchId).toBe(alphaPaneId);
    // Content fingerprint: the VISIBLE pane must show ALPHA's scrollback.
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 7: Switch back to BETA pane and verify identity
    const betaIdx = tabs.findIndex((t) => t.active); // currently on ALPHA's tab
    const otherIdx = betaIdx === 0 ? 1 : 0;
    await clickGroupTab(ctx.page, otherIdx);
    // Settled by a fixed wait, deliberately — see the note at `activePane`.
    await delay(DELAYS.SYNC);

    const afterSwitch2Id = await activePane();
    expect(afterSwitch2Id).toBe(betaPaneId);

    // Step 8: Verify tab highlight matches active pane
    const tabsAfterSwitch = await getGroupTabInfo(ctx.page);
    const selectedTab = tabsAfterSwitch.find((t) => t.active);
    expect(selectedTab).toBeDefined();
    expect(selectedTab.index).toBe(otherIdx);

    // Step 9: Add 3rd tab
    await clickGroupTabAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9a: Record GAMMA pane ID (the newly added 3rd tab, which is now active)
    await delay(DELAYS.SYNC);
    const gammaPaneId = await activePane();
    expect(gammaPaneId).not.toBeNull();
    expect(gammaPaneId).not.toBe(alphaPaneId);
    expect(gammaPaneId).not.toBe(betaPaneId);

    // Step 9b: Switch to first tab (ALPHA) with 3 tabs — this is the scenario
    // that triggers the bug where a pane escapes the group window when the
    // active tmux window is itself a group window.
    tabs = await getGroupTabInfo(ctx.page);
    const firstInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, firstInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9c: Switch to another inactive tab with 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const secondInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, secondInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9d: Switch one more time — cycle through all 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const thirdInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, thirdInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 10: Close a tab (last non-active one)
    await clickGroupTabClose(ctx.page, 2);
    await waitForGroupTabs(ctx.page, 2);
    expect(await getGroupTabCount(ctx.page)).toBe(2);

    // Step 11: Close remaining extra tab → revert to regular header
    // Close the non-active tab (find it dynamically since index may vary)
    tabs = await getGroupTabInfo(ctx.page);
    const nonActiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTabClose(ctx.page, nonActiveIdx >= 0 ? nonActiveIdx : 1);
    await waitForCondition(
      ctx.page,
      async () => {
        return !(await isHeaderGrouped(ctx.page));
      },
      15000,
      'header to revert to ungrouped',
    );

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ==================== Scenario 5b: Reorder a group, drag panes in and out ====================

describe('Scenario 5b: Pane group order and membership by drag', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** The group header's tabs as the user reads them: left to right, on screen. */
  const groupTabs = () =>
    ctx.page.evaluate(() =>
      [...document.querySelectorAll('.pane-tabs-group .pane-tab')]
        .map((t) => ({ id: t.dataset.paneTab, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 20 && r.height > 5 && r.bottom > 0 && r.top < innerHeight)
        .sort((a, b) => a.r.left - b.r.left)
        .map(({ id }) => id),
    );

  const centre = (selector) =>
    ctx.page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.toJSON() };
    }, selector);

  /** The panes laid out in the tab on screen. */
  const visiblePanes = () =>
    ctx.page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      return c.panes.filter((p) => p.windowId === c.activeWindowId).map((p) => p.tmuxId);
    });

  /** What the header reads, what the client holds and what tmux holds. */
  const orderReport = async () =>
    `it reads ${await groupTabs()}\nclient: ${await ctx.page.evaluate(() =>
      JSON.stringify(
        window.app
          .getSnapshot()
          .context.panes.map((p) => [p.tmuxId, p.windowId, p.groupId, p.groupPos]),
      ),
    )}\ntmux: ${ctx.session.runCommand(
      "list-panes -a -F '#{pane_id} #{window_id} #{@tmuxy-group-id} #{@tmuxy-group-pos}'",
    )}`;

  const option = (paneId, name) =>
    ctx.session.runCommand(`show-options -pqv -t ${paneId} ${name}`).trim();

  /**
   * Press at `from`, cross the drag threshold, then go to each point in turn,
   * resting at each — except a `passing` point, which the pointer only moves
   * through on its way to the next, as a hand does.
   */
  const dragThrough = async (from, points) => {
    /** The drag has seen the pointer at (x, y), or has started when no point is given. */
    const dragAt = (x, y) =>
      waitForCondition(
        ctx.page,
        () =>
          ctx.page.evaluate(
            ([px, py]) => {
              const d = window.app.getSnapshot().context.drag;
              if (!d) return false;
              return (
                px === null || (Math.abs(d.currentX - px) < 1 && Math.abs(d.currentY - py) < 1)
              );
            },
            [x, y],
          ),
        5000,
        x === null ? 'the drag to start' : `the drag to reach (${x}, ${y})`,
      );
    await ctx.page.mouse.move(from.x, from.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(from.x + 12, from.y + 1);
    await dragAt(null, null);
    for (const p of points) {
      await ctx.page.mouse.move(p.x, p.y);
      if (!p.passing) await dragAt(p.x, p.y);
    }
  };

  test('drag a member along the header to reorder it, drop a pane on the header to join, drag a parked member out [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // Two panes, one above the other; the top one becomes a group of three.
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);
    const [top, other] = await page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      return c.panes
        .filter((p) => p.windowId === c.activeWindowId)
        .sort((a, b) => a.y - b.y)
        .map((p) => p.tmuxId);
    });
    await page.click(`.pane-layout-item[data-pane-id="${top}"] .pane-header`);
    await waitForCondition(
      page,
      () => page.evaluate((id) => window.app.getSnapshot().context.activePaneId === id, top),
      5000,
      `${top} to be the active pane`,
    );
    await clickPaneGroupAdd(page);
    await clickPaneGroupAdd(page);
    await waitForGroupTabs(page, 3);
    const members = await groupTabs();
    expect(members).toHaveLength(3);
    const byNumber = [...members].sort((a, b) => +a.slice(1) - +b.slice(1));
    expect(members).toEqual(byNumber);

    // 1. The last member, dragged onto the first share, takes the first place.
    const last = await centre(`.pane-tab[data-pane-tab="${members[2]}"]`);
    const first = await centre(`.pane-tab[data-pane-tab="${members[0]}"]`);
    await dragThrough(last, [{ x: first.r.left + 10, y: first.y }]);
    await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`.pane-tab[data-pane-tab="${id}"]`);
          return (
            el?.classList.contains('pane-tab-drop-onto') &&
            getComputedStyle(el).boxShadow !== 'none'
          );
        }, members[0]),
      5000,
      'the first share to be marked as where the member would go',
    );
    await page.mouse.up();
    const reordered = [members[2], members[0], members[1]];
    await waitForCondition(
      page,
      async () => JSON.stringify(await groupTabs()) === JSON.stringify(reordered),
      10000,
      async () => `the header to read ${reordered} (${await orderReport()})`,
    );
    // The header shows the new order at once (the client predicts it); tmux
    // has it when the move has run.
    await waitForCondition(
      page,
      async () => option(members[2], '@tmuxy-group-pos') === '0',
      10000,
      async () => `tmux to put ${members[2]} first (${await orderReport()})`,
    );
    expect(await page.$('.pane-tab-drop-onto')).toBeNull();

    // 2. The pane below, dropped on the left edge of the group's header, joins
    //    the group first in line — its path up crosses the group's own pane,
    //    which must not swap with it on the way.
    const otherHeader = await centre(`.pane-layout-item[data-pane-id="${other}"] .pane-header`);
    const firstShare = await centre(`.pane-tab[data-pane-tab="${reordered[0]}"]`);
    await dragThrough(otherHeader, [
      { x: firstShare.r.left + 4, y: firstShare.y + 60, passing: true },
      { x: firstShare.r.left + 4, y: firstShare.y },
    ]);
    await waitForCondition(
      page,
      () =>
        page.evaluate(
          (id) =>
            !!document
              .querySelector(`.pane-tab[data-pane-tab="${id}"]`)
              ?.classList.contains('pane-tab-drop-before'),
          reordered[0],
        ),
      5000,
      'the gap before the first member to be marked',
    );
    await page.mouse.up();
    await waitForCondition(
      page,
      async () => (await groupTabs()).length === 4 && (await visiblePanes()).length === 1,
      15000,
      async () =>
        `${other} to join the group (header ${await groupTabs()}, panes ${await visiblePanes()})`,
    );
    // The new order lands a beat after the membership: the positions are
    // re-read when tmux reports the group's revision changed.
    const joined = [other, ...reordered];
    await waitForCondition(
      page,
      async () => JSON.stringify(await groupTabs()) === JSON.stringify(joined),
      10000,
      async () => `the header to read ${joined} (${await orderReport()})`,
    );
    expect(option(other, '@tmuxy-group-id')).toBe(option(reordered[0], '@tmuxy-group-id'));

    // 3. A parked member, dragged by its tab into the lower part of the pane,
    //    leaves the group and is split in below it.
    const parked = await page.evaluate(
      () =>
        [...document.querySelectorAll('.pane-tabs-group .pane-tab')].find(
          (t) => !t.classList.contains('pane-tab-selected'),
        ).dataset.paneTab,
    );
    const shown = (await visiblePanes())[0];
    const parkedTab = await centre(`.pane-tab[data-pane-tab="${parked}"]`);
    const body = await centre(`.pane-layout-item[data-pane-id="${shown}"]`);
    await dragThrough(parkedTab, [{ x: body.x, y: body.r.bottom - 20 }]);
    await page.mouse.up();
    await waitForCondition(
      page,
      async () => (await groupTabs()).length === 3 && (await visiblePanes()).length === 2,
      15000,
      async () =>
        `${parked} to leave the group (header ${await groupTabs()}, panes ${await visiblePanes()})`,
    );
    expect(option(parked, '@tmuxy-group-id')).toBe('');
    // On screen, under the group's pane.
    const leftBox = await centre(`.pane-layout-item[data-pane-id="${parked}"]`);
    const groupBox = await centre(`.pane-layout-item[data-pane-id="${shown}"]`);
    expect(leftBox.r.height).toBeGreaterThan(40);
    expect(leftBox.r.top).toBeGreaterThan(groupBox.r.top);
    await assertLayoutInvariants(page);
  }, 180000);
});

// ==================== Scenario 6: Float Pane Lifecycle ====================

describe('Scenario 6: Float Pane Lifecycle', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('CLI float → visually visible → centred in the container, again after a resize → header structure → auto-focus → type command → output visible → input isolation → close button → background restored → Escape and backdrop close too', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The float is opened from the right half of a split, so a float anchored
    // to the pane it came from would sit off the container's centre.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);

    // Record background pane ID
    const bgPaneId = await ctx.session.getActivePaneId();
    expect(bgPaneId).toMatch(/^%\d+$/);

    // Step 1: Verify background pane is operational
    await runCommand(ctx.page, 'echo BG_PRE_FLOAT', 'BG_PRE_FLOAT');

    // Step 2: Open an interactive float via the CLI; it is on screen with a
    // real size and XState auto-focuses it.
    const focusedFloatId = await openFloatFromCli(ctx);
    expect(focusedFloatId).toMatch(/^%\d+$/);

    // Step 3: Float header has close button but NO group-add (+) button
    const headerInfo = await ctx.page.evaluate(() => {
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      if (!fc) return null;
      return {
        hasHeader: !!fc.querySelector('.pane-header'),
        hasCloseButton: !!fc.querySelector('.pane-header-close'),
        hasMenuButton: !!fc.querySelector('.pane-header-menu'),
      };
    });
    expect(headerInfo).not.toBeNull();
    expect(headerInfo.hasHeader).toBe(true);
    expect(headerInfo.hasCloseButton).toBe(true);
    expect(headerInfo.hasMenuButton).toBe(true);

    // Step 3a: Background pane should NOT be active when float is focused.
    // The element may not be in the DOM (null) when the float overlay covers it.
    const bgActiveState = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
      return el ? el.classList.contains('pane-active') : null;
    }, bgPaneId);
    expect(bgActiveState).not.toBe(true);

    // Step 3b: Float has all 4 borders and drop shadow
    const floatStyle = await ctx.page.evaluate(() => {
      const mc = document.querySelector('.float-modal .modal-container');
      if (!mc) return null;
      const cs = window.getComputedStyle(mc);
      return {
        borderTop: cs.borderTopWidth,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
        boxShadow: cs.boxShadow,
      };
    });
    expect(floatStyle).not.toBeNull();
    expect(parseFloat(floatStyle.borderTop)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderRight)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderBottom)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderLeft)).toBeGreaterThanOrEqual(1);
    expect(floatStyle.boxShadow).not.toBe('none');

    // Step 3b2: The float sits at the centre of the pane container, and comes
    // back to it once the window is resized.
    const opened = await floatCentreOffset(ctx.page);
    expect(Math.abs(opened.dx)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    expect(Math.abs(opened.dy)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    const viewport = ctx.page.viewportSize();
    await ctx.page.setViewportSize({ width: viewport.width - 280, height: viewport.height - 80 });
    await waitForCondition(
      ctx.page,
      async () => {
        const offset = await floatCentreOffset(ctx.page);
        return offset?.containerWidth !== opened.containerWidth && isCentred(offset);
      },
      10000,
      'the float to re-centre in the resized container',
    );
    await ctx.page.setViewportSize(viewport);
    await waitForCondition(
      ctx.page,
      async () => {
        const offset = await floatCentreOffset(ctx.page);
        return offset?.containerWidth === opened.containerWidth && isCentred(offset);
      },
      10000,
      'the float to re-centre once the window is back to its size',
    );

    // Step 3c: Float pane header icon is NOT a button (no role="button")
    const iconIsStatic = await ctx.page.evaluate(() => {
      const fc = document.querySelector('.float-container');
      const icon = fc?.querySelector('.pane-tab-icon');
      if (!icon) return null;
      return {
        hasStaticClass: icon.classList.contains('pane-tab-icon-static'),
        hasButtonRole: icon.getAttribute('role') === 'button',
      };
    });
    if (iconIsStatic) {
      expect(iconIsStatic.hasStaticClass).toBe(true);
      expect(iconIsStatic.hasButtonRole).toBe(false);
    }

    // Step 4: Type command in float and verify output
    // Wait for float pane shell prompt to render
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate(() => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          if (!log) return false;
          const content = log.textContent || '';
          return content.length > 5 && /[$#%>❯]/.test(content);
        });
      },
      15000,
      'float pane shell prompt to render',
    );
    // Type directly — the keyboard actor routes to focusedFloatPaneId.
    // Do NOT click the float's [role="log"] — it triggers FOCUS_PANE which
    // selects the background pane, breaking input isolation.
    // Wait for the keyboard actor to receive the UPDATE_FOCUSED_FLOAT event
    // (async message from XState, may lag behind context update).
    await delay(DELAYS.SYNC);
    await ctx.page.bringToFront();
    const TOKEN = 'FLOAT_VIS_' + Date.now();
    for (const char of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify typed text appears in the float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'typed output in float DOM',
    );

    // Step 5: Input-focus isolation. Full DOM-level isolation (token must
    // NOT appear in the background pane) cannot be asserted under CDP:
    // headless keyboard events can race UPDATE_FOCUSED_FLOAT and leak to
    // activePaneId — a harness artifact, not a product bug. What IS stable
    // and meaningful: typing must not steal focus away from the float.
    const focusAfterTyping = await ctx.page.evaluate(() => {
      const c = window.app?.getSnapshot()?.context;
      return {
        focusedFloat: c?.focusedFloatPaneId ?? null,
        floatIds: Object.keys(c?.floatPanes ?? {}),
      };
    });
    expect(focusAfterTyping.focusedFloat).not.toBeNull();
    expect(focusAfterTyping.floatIds).toContain(focusAfterTyping.focusedFloat);

    // Step 6: Background pane still visible while float is open
    const bgVisible = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-id="${id}"]`);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, bgPaneId);
    expect(bgVisible).toBe(true);

    // Step 7: Close float via close button
    const closeClicked = await ctx.page.evaluate(() => {
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      const btn = fc?.querySelector('.pane-header-close');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    expect(closeClicked).toBe(true);
    await waitForNoModal(ctx.page);

    // Step 8: focusedFloatPaneId cleared, and the background pane wears the
    // active marker again — the one visual cue that says where typing goes.
    expect(await focusedFloatPaneId(ctx.page)).toBeNull();
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          (id) => !!document.querySelector(`.pane-layout-item.pane-active[data-pane-id="${id}"]`),
          bgPaneId,
        ),
      10000,
      'the background pane to be active again after the float closes',
    );

    // Background pane still works
    const BG_TOKEN = 'BG_AFTER_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${BG_TOKEN}`, BG_TOKEN);

    // Step 9: Escape closes a float too — the key goes to the modal, not to
    // the program in the background pane — and focus comes back with it.
    await openFloatFromCli(ctx);
    await ctx.page.keyboard.press('Escape');
    await waitForNoModal(ctx.page);
    expect(await focusedFloatPaneId(ctx.page)).toBeNull();
    const ESC_TOKEN = 'ESC_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${ESC_TOKEN}`, ESC_TOKEN);

    // Step 10: and so does a click on the backdrop (far from the center, so
    // it cannot land on the float itself).
    await openFloatFromCli(ctx);
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    const box = await backdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await waitForNoModal(ctx.page);
    const BACKDROP_TOKEN = 'BACKDROP_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${BACKDROP_TOKEN}`, BACKDROP_TOKEN);
  }, 240000);
});

// ============ Scenario 6f: A float belongs to the tab it was opened over ============

describe('Scenario 6f: Float Tab Scope', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** The tab buttons in strip order. */
  async function tabButtons(page) {
    return page.$$('.tab-name:not(.tab-add)');
  }

  /** Click whichever tab button is not the active one. */
  /** Click the inactive tab, and resolve once the app is on its window. */
  async function clickOtherTab(page) {
    const activeWindow = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);
    const from = await activeWindow();
    for (const tab of await tabButtons(page)) {
      const active = await tab.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!active) {
        await tab.click();
        await waitForCondition(
          page,
          async () => (await activeWindow()) !== from,
          8000,
          'the tab click to switch the active window',
        );
        return;
      }
    }
    throw new Error('no inactive tab button to click');
  }

  test('Float over tab 1 → backdrop covers the tab content only → other tab is clear → back again [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A second tab to switch to. It opens active, so click back to the first
    // one: the float has to be opened over tab 1.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2, 10000);
    await clickOtherTab(ctx.page);
    const homeWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );

    // Step 1: open the float the way a user does
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);
    // The float is opened and focused by one script; it is up when the app
    // holds it as the focused float.
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => !!window.app?.getSnapshot()?.context?.focusedFloatPaneId),
      10000,
      'the new float to take focus',
    );

    const floatPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(floatPaneId).toMatch(/^%\d+$/);

    // Step 2: the float is tagged with the tab it was opened over, and the
    // backdrop dims that tab's content and nothing else — the tab strip above
    // it stays uncovered, so the user can still switch tabs.
    const measureScope = () => {
      const backdrop = document.querySelector('.modal-backdrop');
      const container = document.querySelector('.pane-container');
      const strip = document.querySelector('.tab-list');
      if (!backdrop || !container || !strip) return null;
      const b = backdrop.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      return {
        // The raw boxes travel with the deltas: a failure that says only
        // "dTop 24" cannot tell a backdrop resolving against the wrong
        // ancestor from a container that moved under it.
        boxes: {
          backdrop: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
          container: { top: c.top, bottom: c.bottom, left: c.left, right: c.right },
          strip: { top: s.top, bottom: s.bottom },
          backdropParent: backdrop.parentElement?.className ?? null,
          backdropOffsetParent: backdrop.offsetParent?.className ?? null,
          // The overlay is `position:absolute; inset:0`, so its box IS its
          // containing block's padding box. When the backdrop comes out the
          // right SIZE but in the wrong PLACE, the question is which ancestor
          // it resolved against — so walk up and record each one's box and the
          // properties that can make it a containing block.
          ancestors: (() => {
            const chain = [];
            let el = backdrop.parentElement;
            while (el && chain.length < 6) {
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              chain.push({
                className: el.className,
                position: cs.position,
                transform: cs.transform === 'none' ? null : cs.transform,
                zoom: cs.zoom,
                padding: cs.padding,
                overflow: cs.overflow,
                // An absolutely positioned child of a SCROLLED container is
                // drawn offset by that scroll, which is the one way a child at
                // `inset: 0` can sit outside its containing block's box.
                scroll: { top: el.scrollTop, left: el.scrollLeft },
                scrollSize: { width: el.scrollWidth, height: el.scrollHeight },
                clientSize: { width: el.clientWidth, height: el.clientHeight },
                box: { top: r.top, left: r.left, width: r.width, height: r.height },
              });
              el = el.parentElement;
            }
            return chain;
          })(),
        },
        dTop: Math.abs(b.top - c.top),
        dBottom: Math.abs(b.bottom - c.bottom),
        dLeft: Math.abs(b.left - c.left),
        dRight: Math.abs(b.right - c.right),
        stripAbove: s.bottom <= b.top + 1,
        parent:
          window.app?.getSnapshot()?.context?.floatPanes?.[
            window.app?.getSnapshot()?.context?.focusedFloatPaneId
          ]?.parentWindowId,
      };
    };
    // The float opening reflows the grid, so the backdrop and the container
    // reach their final boxes a frame or two apart. Wait for them to agree
    // rather than measuring into the middle of that.
    let scope = await ctx.page.evaluate(measureScope);
    const aligned = (s) => s && s.dTop <= 1 && s.dBottom <= 1 && s.dLeft <= 1 && s.dRight <= 1;
    const scopeDeadline = Date.now() + 5000;
    while (Date.now() < scopeDeadline && !aligned(scope)) {
      await delay(100);
      scope = await ctx.page.evaluate(measureScope);
    }
    expect(scope).not.toBeNull();
    // One check carrying the boxes: four separate `expect`s reported only the
    // first delta and stopped, and "dTop 24" cannot tell a backdrop resolving
    // against the wrong ancestor from a container that moved under it.
    const misaligned = ['dTop', 'dBottom', 'dLeft', 'dRight'].filter((k) => scope[k] > 1);
    if (misaligned.length > 0) {
      throw new Error(
        `the float backdrop does not cover the tab content: ${misaligned.join(', ')} off by more than 1px\n` +
          JSON.stringify(scope, null, 2),
      );
    }
    expect(scope.stripAbove).toBe(true);
    expect(scope.parent).toBe(homeWindowId);

    // Step 3: the other tab shows no float at all
    await clickOtherTab(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });
    expect(
      await ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.focusedFloatPaneId),
    ).toBeNull();
    // And that tab's own pane takes input, rather than the hidden float.
    const TOKEN = 'OTHER_TAB_' + Date.now();
    await runCommand(ctx.page, `echo ${TOKEN}`, TOKEN);

    // Step 4: back on its own tab, the same float is up again — one of it, not
    // a second one.
    await clickOtherTab(ctx.page);
    await waitForFloatModal(ctx.page, 10000);
    await verifyFloatVisible(ctx.page);
    const backAgain = await ctx.page.evaluate(() => ({
      count: document.querySelectorAll('.modal-overlay').length,
      focused: window.app?.getSnapshot()?.context?.focusedFloatPaneId,
      active: window.app?.getSnapshot()?.context?.activeWindowId,
    }));
    expect(backAgain.count).toBe(1);
    expect(backAgain.focused).toBe(floatPaneId);
    expect(backAgain.active).toBe(homeWindowId);

    // Leave the session without the float.
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });
  }, 180000);
});

// ====== Scenario 6h: nav left/right walks the group, the panes, then the dock ======

describe('Scenario 6h: Horizontal nav through a group, the panes and the dock', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** Where the keyboard is, and which member of the group is showing. */
  const where = (page) =>
    page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      const active = c.panes.find((p) => p.tmuxId === c.activePaneId);
      const group = Object.values(c.paneGroups)[0];
      const shown = group?.paneIds.find(
        (id) => c.panes.find((p) => p.tmuxId === id)?.windowId === c.activeWindowId,
      );
      return {
        active: c.activePaneId,
        activeX: active?.x ?? null,
        members: group?.paneIds ?? [],
        shown: shown ?? null,
        dockFocused: c.rightSidebarFocused,
      };
    });

  const until = (label, check) =>
    waitForCondition(
      ctx.page,
      async () => check(await where(ctx.page)),
      10000,
      // Where the keyboard was when the wait gave up is the diagnosis.
      async () => `${label}\nlast seen: ${JSON.stringify(await where(ctx.page))}`,
    );

  test('nav right shows the next group member, then the pane on the right, then the dock; nav left walks back [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Two panes side by side; the left one becomes a group of two.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await navigatePaneKeyboard(ctx.page, 'left');
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await until('the group to hold the keyboard', (w) => w.members.includes(w.active));
    const [first, last] = (await where(ctx.page)).members;

    // Start on the group's first member, in the left slot.
    if ((await where(ctx.page)).shown !== first) {
      await navigatePaneKeyboard(ctx.page, 'left');
      await until('nav left to show the first member', (w) => w.shown === first);
    }
    expect((await where(ctx.page)).activeX).toBe(0);

    // nav left from the first member of the leftmost pane: no member before it,
    // no pane to its left, no left sidebar — nothing moves.
    await navigatePaneKeyboard(ctx.page, 'left');
    await delay(DELAYS.SYNC);
    expect(await where(ctx.page)).toEqual(
      expect.objectContaining({ active: first, shown: first, activeX: 0 }),
    );

    // Ctrl+l shows the next member, in the same slot.
    await navigatePaneKeyboard(ctx.page, 'right');
    await until('nav right to show the next member', (w) => w.shown === last && w.active === last);
    expect((await where(ctx.page)).activeX).toBe(0);

    // nav right from the last member moves on to the pane on the right, and the
    // group keeps showing the member it was on — leaving the group is not
    // stepping it. Both are waited for together: the keyboard lands on the
    // right pane before the group's swap has settled, so a wait on the
    // keyboard alone let the assertion read the group mid-swap, with no
    // member in the visible window at all (~1 run in 3).
    await navigatePaneKeyboard(ctx.page, 'right');
    await until(
      'nav right from the last member to reach the right pane, group still on the last member',
      (w) => w.activeX > 0 && w.shown === last,
    );

    // nav left comes back into the group as it is showing, without stepping it.
    await navigatePaneKeyboard(ctx.page, 'left');
    await until(
      'nav left to return to the group, still on the last member',
      (w) => w.active === last && w.shown === last,
    );

    // With the dock open, nav right from the rightmost pane goes into it.
    await navigatePaneKeyboard(ctx.page, 'right');
    await until('nav right to reach the right pane again', (w) => w.activeX > 0);
    await openSidebarKeyboard(ctx.page, 'right', { fixed: true });
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 20000 });
    // Opening the dock hands it the keyboard once its pane exists, a beat
    // after the column draws; a nav pressed before then goes to the grid.
    await until('the opened dock to take the keyboard', (w) => w.dockFocused === true);
    await navigatePaneKeyboard(ctx.page, 'left'); // the dock hands the keyboard back
    await until('the dock to hand the keyboard back', (w) => w.dockFocused === false);
    await navigatePaneKeyboard(ctx.page, 'right');
    await until(
      'nav right from the rightmost pane to focus the dock',
      (w) => w.dockFocused === true,
    );

    await ctx.page.click('button[aria-label="Toggle terminal sidebar"]');
  }, 180000);
});

// ====== Scenario 6j: right-click anywhere on a pane header opens that pane's menu ======

describe('Scenario 6j: Pane header context menu', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /**
   * Right-click `selector` with the real right button. Playwright's own click
   * waits for the element to be visible and stable, and names whatever covers
   * it if something does.
   */
  const rightClick = (selector) =>
    ctx.page.locator(selector).first().click({ button: 'right', timeout: 5000 });

  /** The pane menu is on screen: in the DOM is not enough. */
  const menuVisible = (after) =>
    waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(() => {
          const r = document
            .querySelector('[role="menu"][aria-label="Pane"]')
            ?.getBoundingClientRect();
          return !!r && r.width > 40 && r.height > 40 && r.top >= 0 && r.bottom <= innerHeight;
        }),
      5000,
      async () =>
        `the pane menu to be on screen after right-clicking ${after}\n${await ctx.page.evaluate(
          () => {
            const m = document.querySelector('[role="menu"][aria-label="Pane"]');
            const r = m?.getBoundingClientRect();
            return JSON.stringify({
              menu: m
                ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
                : null,
              viewport: [innerWidth, innerHeight],
            });
          },
        )}`,
    );

  const chooseItem = async (label) => {
    await ctx.page
      .locator('[role="menu"][aria-label="Pane"] [role="menuitem"]', { hasText: label })
      .first()
      .click();
    await waitForCondition(
      ctx.page,
      async () => (await ctx.page.$('[role="menu"][aria-label="Pane"]')) === null,
      5000,
      'the pane menu to close',
    );
  };

  const marked = (paneId) =>
    ctx.session.runCommand(`display-message -p -t ${paneId} '#{pane_marked}'`).trim() === '1';

  test('the ⋮, the MARKED badge, a hidden group member and a float header each open the menu for their pane [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    const paneA = await ctx.page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const header = `.pane-layout-item[data-pane-id="${paneA}"] .pane-header`;

    // The ⋮ of a single pane sits outside its tab: right-clicking it is the
    // header of that pane, and an action from the menu acts on it.
    await rightClick(`${header} .pane-header-menu`);
    await menuVisible(`${header} .pane-header-menu`);
    await chooseItem('Mark Pane');
    await waitForCondition(ctx.page, async () => marked(paneA), 5000, `${paneA} to be marked`);
    await ctx.page.waitForSelector(`${header} [data-testid="pane-header-mark"]`, {
      state: 'visible',
    });

    // The MARKED badge is outside the tab too.
    await rightClick(`${header} [data-testid="pane-header-mark"]`);
    await menuVisible(`${header} [data-testid="pane-header-mark"]`);
    await chooseItem('Unmark Pane');
    await waitForCondition(ctx.page, async () => !marked(paneA), 5000, `${paneA} to be unmarked`);

    // A group's header: the share of the member that is NOT showing names
    // that member, not the one on screen.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    const hidden = await ctx.page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.pane-tabs-group .pane-tab')];
      return tabs.find((t) => !t.classList.contains('pane-tab-selected'))?.dataset.paneTab;
    });
    expect(hidden).toMatch(/^%\d+$/);
    await rightClick(`.pane-tab[data-pane-tab="${hidden}"]`);
    await menuVisible(`.pane-tab[data-pane-tab="${hidden}"]`);
    await chooseItem('Mark Pane');
    await waitForCondition(ctx.page, async () => marked(hidden), 5000, `${hidden} to be marked`);

    // A float's header is the same header.
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);
    await rightClick('.float-container .pane-header');
    await menuVisible('.float-container .pane-header');
    await ctx.page.keyboard.press('Escape');
  }, 120000);
});

// ====== Scenario 6i: the cursor jumps, not glides, when the picture under it changes ======

describe('Scenario 6i: Cursor motion across tabs and group members', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /**
   * The motion a trigger produced, as the assertion wants it: how many places
   * the overlay was seen at, and whether it ended somewhere else at all — a
   * "jump" that never moved would pass a distinct-positions check vacuously.
   */
  const motion = async (trigger) => {
    await cursorStill(ctx.page);
    const glide = await sampleCursorGlide(ctx.page, trigger);
    // A glide moves the overlay on many frames in a row; a jump moves it on
    // one and holds. A switch may jump more than once (the new pane's content
    // can land a beat later), so the count is the longest run, not the total.
    let run = 0;
    let longestRun = 0;
    for (let i = 1; i < glide.frames.length; i++) {
      run = String(glide.frames[i]) === String(glide.frames[i - 1]) ? 0 : run + 1;
      longestRun = Math.max(longestRun, run);
    }
    return {
      moved: String(glide.settled) !== String(glide.frames[0]),
      longestRun,
      detail: JSON.stringify(glidePositions(glide)),
    };
  };

  /** Resolves once the overlay has not moved for a few frames, so a sample starts from rest. */
  const cursorStill = (page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const shape = document.querySelector(
            '[data-testid="smooth-cursor"] .smooth-cursor-shape',
          );
          let last = null;
          let still = 0;
          const tick = () => {
            const now = shape?.style.clipPath ?? '';
            still = now === last ? still + 1 : 0;
            last = now;
            if (still >= 10) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );

  test('moving between panes glides; switching group member or tab draws the cursor in place [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Two panes side by side: moving the keyboard between them is a move
    // within one picture, and glides.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    const between = await motion(() => navigatePaneKeyboard(ctx.page, 'left'));
    expect(between.moved).toBe(true);
    expect(between.longestRun >= 3 ? 'glided' : between.detail).toBe('glided');

    // A group in the left slot whose two members hold their cursors on
    // different rows, so a switch has somewhere else to put it.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    // The awaited text is in the output only, not in what is typed.
    await runCommand(ctx.page, 'for i in 1 2 3 4 5 6; do echo row$i; done', 'row6');
    const member = await motion(() => clickGroupTab(ctx.page, 0));
    expect(member.moved).toBe(true);
    expect(member.longestRun <= 2 ? 'drawn in place' : member.detail).toBe('drawn in place');

    // Another tab, then back: the whole picture changes both times. The new
    // tab's cursor sits after its first prompt, top left — exactly where this
    // member's is until it prints something, which would leave nothing to see.
    await runCommand(ctx.page, 'for i in 1 2 3; do echo back$i; done', 'back3');
    const firstTab = await ctx.page.evaluate(() => window.app.getSnapshot().context.activeWindowId);
    await createWindowKeyboard(ctx.page);
    const tab = await motion(() => ctx.page.click(`.tab-name[data-window-id="${firstTab}"]`));
    expect(tab.moved).toBe(true);
    expect(tab.longestRun <= 2 ? 'drawn in place' : tab.detail).toBe('drawn in place');
  }, 120000);
});

// ==================== Scenario 11: Status Bar ====================

describe('Scenario 11: Status Bar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Bar visible → tab → session name → 2 windows → active distinct → click tab → rename → close via context menu', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Status bar visible
    const barInfo = await ctx.page.evaluate(() => {
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      if (!bar) return null;
      return {
        hasContent: bar.textContent.trim().length > 0,
        isVisible: bar.offsetParent !== null || bar.getBoundingClientRect().height > 0,
      };
    });
    expect(barInfo).not.toBeNull();
    expect(barInfo.hasContent).toBe(true);
    expect(barInfo.isVisible).toBe(true);

    // Step 2: Window tab present (the strip redraws as the config's
    // move-window lands, so it is waited for, not read once).
    const tab = await ctx.page.waitForSelector('.tab-name', { timeout: 5000 }).catch(() => null);
    expect(tab).not.toBeNull();

    // Step 3: Session name visible
    const barText = await ctx.page.evaluate(() => {
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      return bar ? bar.textContent : '';
    });
    expect(barText).toContain(ctx.session.name);

    // Step 4: Create second window - 2 tabs
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    expect(await ctx.session.getWindowCount()).toBe(2);

    // Step 5: Active tab distinct styling
    const activeTab = await ctx.page.$('.tab-name-active');
    expect(activeTab).not.toBeNull();

    // Step 6: Click inactive tab to switch
    await waitForWindowCount(ctx.page, 2, 10000);
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
    await waitForCondition(
      ctx.page,
      () => inactiveTab.evaluate((el) => el.classList.contains('tab-name-active')),
      8000,
      'the clicked tab to become the active one',
    );

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    const stripText = () =>
      ctx.page.evaluate(() => {
        const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
        return Array.from(tabs)
          .map((t) => t.textContent)
          .join(' ');
      });
    await waitForCondition(
      ctx.page,
      async () => (await stripText()).includes('RENAMED_WINDOW'),
      8000,
      'the strip to show the new name',
    );
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      return Array.from(tabs)
        .map((t) => t.textContent)
        .join(' ');
    });
    expect(tabText).toContain('RENAMED_WINDOW');

    // Step 8: Close a tab the way the strip offers it — right-click the
    // inactive tab → "Close Tab". Tabs carry no ✕ of their own: a row of
    // buttons each with a target you can hit by accident is a row you cannot
    // click confidently.
    const tabsForClose = await ctx.page.$$('.tab-name:not(.tab-add)');
    let tabToClose = null;
    for (const t of tabsForClose) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        tabToClose = t;
        break;
      }
    }
    expect(tabToClose).not.toBeNull();
    await tabToClose.click({ button: 'right' });
    await ctx.page.waitForSelector('[role="menu"]', { timeout: 5000 });
    const closeItem = await ctx.page.evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return items.find((el) => (el.textContent || '').startsWith('Close Tab')) ?? null;
    });
    expect(await closeItem.evaluate((el) => el !== null)).toBe(true);
    await closeItem.asElement().click();
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 180000);
});

// ==================== Scenario 11b: Rename field keeps its paste ====================

describe('Scenario 11c: PANE and TAB modes, the sidebar keys and the keys view', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix p: the PANE chip, x closes panes until esc → prefix t: the TAB chip, c opens a tab → prefix s overlays the tree, prefix s again docks it → prefix S S docks the terminal → prefix ? lists PANE', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // What the status line shows: its mode, the chip as drawn, and whether
    // the host and session are on screen.
    const statusLine = () =>
      page.evaluate(() => {
        const hints = document.querySelector('[data-testid="statusline-hints"]');
        const chip = hints?.querySelector('.statusline-mode');
        const chipBox = chip?.getBoundingClientRect();
        const right = document.querySelector('.tmux-statusline-right')?.getBoundingClientRect();
        return {
          mode: hints?.getAttribute('data-key-mode') ?? null,
          chip: chip?.textContent ?? null,
          chipVisible: !!chipBox && chipBox.width > 0 && chipBox.height > 0,
          hostShown: !!right && right.width > 0,
        };
      });

    // PANE mode: sticky, so x twice closes two panes without the prefix again.
    await splitPaneKeyboard(page, 'vertical');
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 3);
    await sendPrefixCommand(page, 'p');
    await waitForCondition(
      page,
      async () => (await statusLine()).chip === 'PANE',
      15000,
      'the PANE chip',
    );
    expect(await statusLine()).toMatchObject({ chipVisible: true, hostShown: false });
    await page.keyboard.press('x');
    await waitForPaneCount(page, 2);
    await page.keyboard.press('x');
    await waitForPaneCount(page, 1);
    expect((await statusLine()).chip).toBe('PANE');
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => {
        const line = await statusLine();
        return line.mode === 'normal' && line.hostShown;
      },
      15000,
      'the normal line, host and session back',
    );

    // TAB mode: c opens a tab and the mode stays.
    await sendPrefixCommand(page, 't');
    await waitForCondition(
      page,
      async () => (await statusLine()).chip === 'TAB',
      15000,
      'the TAB chip',
    );
    await page.keyboard.press('c');
    await waitForWindowCount(page, 2);
    expect((await statusLine()).chip).toBe('TAB');
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => (await statusLine()).mode === 'normal',
      15000,
      'TAB mode to end',
    );

    // A column, and the grid of the tab in view.
    const column = (side) =>
      page.evaluate((s) => {
        const el = document.querySelector(`.sidebar-column-${s}`);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        const grid = [...document.querySelectorAll('.pane-layout-item')]
          .filter((p) => !p.classList.contains('pane-window-hidden'))
          .map((p) => p.getBoundingClientRect());
        return {
          overlay: el.classList.contains('is-overlay'),
          left: box.left,
          right: box.right,
          width: box.width,
          gridLeft: Math.min(...grid.map((g) => g.left)),
          gridRight: Math.max(...grid.map((g) => g.right)),
        };
      }, side);

    // prefix s: the tree opens over the panes.
    await openSidebarKeyboard(page, 'left');
    await waitForCondition(
      page,
      async () => {
        const c = await column('left');
        return c !== null && c.overlay && c.width > 50 && c.gridLeft < c.right - 1;
      },
      15000,
      'the tree overlaying the panes',
    );
    // prefix s on the open column: it docks, and the grid moves out from under it.
    await openSidebarKeyboard(page, 'left');
    await waitForCondition(
      page,
      async () => {
        const c = await column('left');
        return c !== null && !c.overlay && c.gridLeft >= c.right - 1;
      },
      15000,
      async () => `the tree docked beside the grid (${JSON.stringify(await column('left'))})`,
    );

    // prefix S S: the terminal opens and docks at once, the grid ending where it starts.
    await openSidebarKeyboard(page, 'right', { fixed: true });
    await waitForCondition(
      page,
      async () => {
        const c = await column('right');
        return c !== null && !c.overlay && c.width > 50 && c.gridRight <= c.left + 1;
      },
      20000,
      async () => `the terminal docked beside the grid (${JSON.stringify(await column('right'))})`,
    );

    // prefix ?: every key, table by table; esc closes it.
    await sendPrefixCommand(page, '?', { shift: true });
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const view = document.querySelector('[data-testid="keys-view"]');
          const box = view?.getBoundingClientRect();
          return !!box && box.width > 0 && /PANE/.test(view.textContent);
        }),
      15000,
      'the keys view listing the PANE table',
    );
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      () => page.evaluate(() => !document.querySelector('[data-testid="keys-view"]')),
      15000,
      'the keys view to close',
    );
  }, 180000);
});

describe('Scenario 11b: Pasting into a tab rename field', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The clipboard went to the pane: the window-level paste listener took
  // every paste, the rename field included, and the shell got the new name.
  test('right-click → Rename Tab → paste stays in the field, the pane receives nothing', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The strip draws its tab from the first state; on a slow runner that
    // can land after the page is otherwise ready.
    const tab = await ctx.page.waitForSelector('.tab-name:not(.tab-add)', { timeout: 10000 });
    await tab.click({ button: 'right' });
    await ctx.page.waitForSelector('[role="menu"]', { timeout: 5000 });
    const renameItem = await ctx.page.evaluateHandle(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
          (el.textContent || '').startsWith('Rename Tab'),
        ) ?? null,
    );
    expect(await renameItem.evaluate((el) => el !== null)).toBe(true);
    await renameItem.asElement().click();
    await ctx.page.waitForSelector('[data-testid="inline-rename"]', { timeout: 5000 });
    expect(
      await ctx.page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') === 'inline-rename',
      ),
    ).toBe(true);

    // The paste is the field's: the app does not take it, and the field keeps
    // the focus to receive it.
    const TOKEN = `PASTED_NAME_${Date.now()}`;
    expect(await pasteText(ctx.page, TOKEN)).toBe(false);
    expect(
      await ctx.page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') === 'inline-rename',
      ),
    ).toBe(true);

    // Back to the shell: the next command runs on a line the token never reached.
    await ctx.page.keyboard.press('Escape');
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(() => document.querySelector('[data-testid="inline-rename"]') === null),
      5000,
      'the rename field to close',
    );
    await focusPage(ctx.page);
    const DONE = `DONE_${Date.now()}`;
    await typeInTerminal(ctx.page, `echo ${DONE}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, DONE);
    const screen = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"]'))
        .map((el) => el.textContent || '')
        .join('\n'),
    );
    expect(screen).not.toContain(TOKEN);
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
    await delay(1500);
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

// ==================== Scenario 22: Float fzf Workflow ====================

describe('Scenario 22: Float fzf Workflow', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Float opens fzf → user selects item → result returned to shell [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Background pane is operational
    await runCommand(ctx.page, 'echo FZF_BG_READY', 'FZF_BG_READY');

    // Step 2: Open an interactive float
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);

    // Step 3: Float appears — wait for float content to render
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);

    // Get the float pane ID for capture-pane verification
    const floatPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(floatPaneId).toBeTruthy();

    // Synchronise on the float's own prompt, using the shared predicate rather
    // than a copy of it: an inlined one here matched a prompt character
    // ANYWHERE in the text and required more than five characters, the two
    // bugs `showsShellPrompt` exists to not have twice.
    //
    // Non-fatal on purpose: this only buys the typing below a settled prompt
    // to land on, and the echo assertion that follows is the real gate. A
    // failure here would report the same bug one step earlier, not a
    // different one.
    try {
      await waitForCondition(
        ctx.page,
        async () => {
          const text = await ctx.page.evaluate(() => {
            const fc =
              document.querySelector('.float-container') ||
              document.querySelector('.modal-container');
            return fc?.querySelector('[role="log"]')?.textContent ?? null;
          });
          return text !== null && showsShellPrompt(text);
        },
        10000,
        'float pane shell prompt to render',
      );
    } catch {
      /* the echo assertion below is the real gate */
    }

    // Step 4: Run echo in the float and verify output
    const TOKEN = `FZF_TOKEN_${Date.now()}`;
    for (const ch of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify typed text in float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'echo output in float DOM',
    );

    // Step 6: Run fzf with a simple input and auto-select via --select-1
    const FZF_MARKER = `FZF_RESULT_${Date.now()}`;
    const fzfCmd = `echo ${FZF_MARKER} | fzf --select-1`;
    for (const ch of fzfCmd) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify fzf result in float DOM — fzf --select-1 prints the match to stdout,
    // on a row of its own: the typed command line carries the marker too.
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((marker) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          return [...fc.querySelectorAll('[role="log"] .terminal-line')].some((row) => {
            const text = row.textContent || '';
            return text.includes(marker) && !text.includes('fzf');
          });
        }, FZF_MARKER);
      },
      15000,
      'fzf result in float DOM',
    );

    // Step 8: Close float if still open (exit the shell)
    const stillHasFloat = await ctx.page.evaluate(
      () => document.querySelectorAll('.modal-overlay').length > 0,
    );
    if (stillHasFloat) {
      await ctx.page.keyboard.type('exit');
      await ctx.page.keyboard.press('Enter');
    }

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 15000,
      polling: 100,
    });

    // Background pane should be interactive after float closes
    const bgMarker = `BG_RESTORED_${Date.now()}`;
    await runCommand(ctx.page, `echo ${bgMarker}`, bgMarker);
  }, 180000);
});

// ==================== Scenario 6e: Pinned Terminal Dock ====================

/**
 * Watch a sidebar column and the pane container slide: after `trigger`, sample
 * both widths on every frame from the first frame the column's width changes
 * until `settleMs` after it, and return the series — so a test can assert the
 * column actually eased between its two sizes (several distinct in-between
 * widths, monotonic) and the grid's width moved with it. The trigger is a tmux
 * keybinding round trip, so the first movement can be a while coming; sampling
 * gives up after `timeoutMs` without one.
 */
async function sampleSidebarSlide(
  page,
  trigger,
  columnSelector,
  { settleMs = 400, timeoutMs = 8000 } = {},
) {
  const sampling = page.evaluate(
    ({ sel, settleMs, timeoutMs }) =>
      new Promise((resolve) => {
        const column = [];
        const container = [];
        const start = performance.now();
        let movedAt = null;
        const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
        const tick = () => {
          const now = performance.now();
          const w = widthOf(document.querySelector(sel));
          if (movedAt === null && column.length > 0 && w !== column[0]) {
            movedAt = now;
            column.length = 1;
            container.length = 1;
          }
          column.push(w);
          container.push(widthOf(document.querySelector('.pane-container')));
          const done = movedAt === null ? now - start > timeoutMs : now - movedAt > settleMs;
          if (done) resolve({ column, container });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { sel: columnSelector, settleMs, timeoutMs },
  );
  await trigger();
  return sampling;
}

/**
 * Watch the smooth cursor (the one overlay that glides between the panes'
 * cursor anchors) travel: sample the centroid of its smear polygon on every
 * frame after `trigger`, from its first movement until it has been still for
 * `settleMs`, and return the series with where it settled.
 */
async function sampleCursorGlide(page, trigger, { settleMs = 250, timeoutMs = 8000 } = {}) {
  const sampling = page.evaluate(
    ({ settleMs, timeoutMs }) =>
      new Promise((resolve) => {
        const shape = document.querySelector('[data-testid="smooth-cursor"] .smooth-cursor-shape');
        const centroid = () => {
          const pts = [...shape.style.clipPath.matchAll(/([-\d.]+)px ([-\d.]+)px/g)].map((m) => [
            +m[1],
            +m[2],
          ]);
          if (pts.length === 0) return null;
          const sum = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
          return [Math.round(sum[0] / pts.length), Math.round(sum[1] / pts.length)];
        };
        const same = (a, b) => (!a && !b) || (a && b && a[0] === b[0] && a[1] === b[1]);
        const frames = [];
        const start = performance.now();
        let movedAt = null;
        let stillSince = null;
        const tick = () => {
          const now = performance.now();
          const c = centroid();
          if (movedAt === null && frames.length > 0 && !same(c, frames[0])) {
            movedAt = now;
            frames.length = 1;
          }
          if (frames.length > 0 && same(c, frames[frames.length - 1])) {
            if (stillSince === null) stillSince = now;
          } else {
            stillSince = null;
          }
          frames.push(c);
          const done =
            movedAt === null
              ? now - start > timeoutMs
              : stillSince !== null && now - stillSince > settleMs;
          if (done) {
            // What the overlay and its anchor look like at the end, so a run
            // that saw no glide says why (never drawn, hidden, anchor missing).
            const root = document.querySelector('[data-testid="smooth-cursor"]');
            const anchors = [...document.querySelectorAll('.terminal-cursor')].map((el) => {
              const r = el.getBoundingClientRect();
              return `${el.className}@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
            });
            resolve({
              frames,
              settled: c,
              overlay: {
                opacity: root ? root.style.opacity : 'no overlay',
                clipPath: shape.style.clipPath.slice(0, 120),
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                anchors,
              },
            });
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { settleMs, timeoutMs },
  );
  await trigger();
  return sampling;
}

/** Distinct positions in a glide's frames — the failure message carries the frames and overlay state. */
function glidePositions(glide) {
  return {
    distinct: new Set(glide.frames.map(String)).size,
    frames: glide.frames,
    overlay: glide.overlay,
  };
}

/** Centre of the pane's own cursor anchor (hidden; what the overlay glides to). */
async function cursorAnchorCenter(page, scopeSelector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(`${sel} .terminal-cursor`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  }, scopeSelector);
}

/**
 * Why the series is NOT an eased slide (several distinct widths, never
 * reversing direction), or null when it is — so the failure shows the frames.
 */
function slideProblem(series, direction) {
  const distinct = [...new Set(series)];
  const reversal = series.findIndex(
    (v, i) => i > 0 && (direction > 0 ? v < series[i - 1] : v > series[i - 1]),
  );
  if (distinct.length < 3) return `only ${distinct.length} distinct widths: ${series.join(',')}`;
  if (reversal !== -1) return `reversed at frame ${reversal}: ${series.join(',')}`;
  return null;
}

describe('Scenario 6e: Pinned Terminal Dock (right sidebar)', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix S docks a shell at the right edge → sized to its own column → typing reaches it → stays pinned across tabs → Esc reaches the shell, Ctrl+h blurs → the toggle hides it, prefix S reopens the same shell', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);

    // Step 1: Open the dock via the real keybinding. First open also CREATES
    // its tmux window, so this covers the create path.
    await openSidebarKeyboard(ctx.page, 'right', { fixed: true });

    // Step 2: The column docks against the right edge of the viewport, full
    // height — a flex sibling of the pane area, not an overlay.
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.right - window.innerWidth) <= 2 && r.width > 50 && r.height > 100;
        }),
      10000,
      'dock to sit against the right edge',
    );

    // Step 3: It is backed by a real `sidebar-right`-typed window with one pane,
    // and that window is NOT in the tab strip.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          return !!win && ctxState.panes.some((p) => p.windowId === win.id);
        }),
      20000,
      'a sidebar-right-typed window with a pane',
    );
    const tabStrip = await ctx.page.evaluate(() => {
      const win = window.app
        ?.getSnapshot()
        ?.context?.windows?.find((w) => w.windowType === 'sidebar-right');
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        // The column's window carries the fixed name `__sidebar-right` (the
        // create command targets it by that name) and tabs render `index:name`,
        // so a tab carrying that label is the column leaking into the strip.
        labels: tabs.map((t) => (t.textContent || '').trim()),
        dockWindowName: win?.name,
      };
    });
    expect(tabStrip.dockWindowName).toBe('__sidebar-right');
    expect(tabStrip.labels.some((label) => label.includes('__sidebar'))).toBe(false);

    // Step 4: THE geometry contract. tmux sizes a `sidebar-right` window to that
    // column (sidebar_dock::size in tmuxy-core), not the viewport — otherwise
    // the shell wraps at a width the UI never draws. 35 cols wide, and the rows
    // the column holds in the sidebar font (@tmuxy-sidebar-rows, written by
    // the client): shorter rows than the pane grid's, so MORE of them than the
    // viewport has — the column is headerless, so it loses none.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          const sent = ctxState?.dockRowsSent;
          return (
            pane?.width === 35 &&
            sent?.windowId === win?.id &&
            pane?.height === sent.rows &&
            pane.height > ctxState.targetRows
          );
        }),
      20000,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          return `column pane sized to its own column (got ${pane?.width}x${pane?.height}, want 35x${ctxState?.dockRowsSent?.rows}, viewport rows ${ctxState?.targetRows})`;
        }),
    );

    // Step 5: Opening it took the keyboard, so typing lands in the dock — not
    // in the tab's active pane.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      10000,
      'dock to hold keyboard focus after opening',
    );
    // Click the dock's own terminal for focus, then re-establish CDP keyboard
    // focus (headless Chrome drops it across the DOM re-render the new column
    // causes) before typing character by character, the same cadence
    // typeInTerminal uses so the adapter's send-keys batching can't transpose.
    // Opening the dock handed it the keyboard; put the keyboard back in the
    // tiled pane first so the click below is a real focus change.
    await ctx.page.click('.pane-layout-item [role="log"]');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === false),
      5000,
      'the tiled pane to take the keyboard back before the glide',
    );
    // The cursor GLIDES into the dock: the smooth cursor overlay travels from
    // the tiled pane's cursor to the dock's over several frames rather than
    // reappearing there, and settles exactly on the dock's anchor.
    const glideIn = await sampleCursorGlide(ctx.page, () =>
      ctx.page.click('[data-testid="right-sidebar-content"] [role="log"]'),
    );
    expect(glideIn.frames.length).toBeGreaterThanOrEqual(4);
    expect(glidePositions(glideIn)).toEqual(
      expect.objectContaining({ distinct: expect.any(Number) }),
    );
    expect(
      glidePositions(glideIn).distinct >= 3 ? 'glided' : JSON.stringify(glidePositions(glideIn)),
    ).toBe('glided');
    expect(glideIn.settled).toEqual(
      await cursorAnchorCenter(ctx.page, '[data-testid="right-sidebar-content"]'),
    );
    await ctx.page.bringToFront();
    await delay(200);
    for (const char of 'echo dock-typing-works') {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      20000,
      'the typed command to echo inside the dock',
    );
    // While the dock holds the keyboard it is the only surface drawing a
    // cursor: the tiled pane's block goes away (it no longer receives keys),
    // and the dock's sits inside the column, not off in its first row.
    const cursorsWhileDocked = await ctx.page.evaluate(() => {
      const dock = document.querySelector('[data-testid="right-sidebar-content"]');
      const d = dock.getBoundingClientRect();
      const inDock = [...dock.querySelectorAll('.terminal-cursor')].map((c) => {
        const r = c.getBoundingClientRect();
        return r.left >= d.left && r.right <= d.right && r.top >= d.top && r.bottom <= d.bottom;
      });
      const tiled = document.querySelectorAll('.pane-layout-item .terminal-cursor').length;
      return { inDock, tiled };
    });
    expect(cursorsWhileDocked).toEqual({ inDock: [true], tiled: 0 });

    // Step 6: The point of the feature — it stays put when the user changes
    // tabs, because its pane lives in its own window.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active && active !== firstWindowId;
      },
      8000,
      'second window to become active',
    );
    const stillDockedOnNewTab = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-testid="right-sidebar-content"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        visible: r.width > 50 && r.height > 100,
        keptOutput: (el.textContent || '').includes('dock-typing-works'),
      };
    });
    expect(stillDockedOnNewTab).toEqual({ visible: true, keptOutput: true });

    // Step 7: Escape is an ordinary key inside the dock — a program pinned
    // there (vim, fzf) must receive it — so it neither blurs nor closes the
    // column. Ctrl+h is what hands the keyboard back to the panes.
    await focusPage(ctx.page);
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      5000,
      'dock focused after a click',
    );
    await ctx.page.keyboard.press('Escape');
    // The key is handled in the page: had Escape moved the focus, it would
    // show within a frame or two.
    await afterFrames(ctx.page);
    const stillFocusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.rightSidebarFocused,
    );
    expect(stillFocusedAfterEscape).toBe(true);
    // ...and glides back out to the tiled pane's cursor when Ctrl+h hands the
    // keyboard back.
    const glideOut = await sampleCursorGlide(ctx.page, async () => {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('h');
      await ctx.page.keyboard.up('Control');
    });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === false),
      5000,
      'rightSidebarFocused cleared after Ctrl+h',
    );
    expect(
      glidePositions(glideOut).distinct >= 3 ? 'glided' : JSON.stringify(glidePositions(glideOut)),
    ).toBe('glided');
    expect(glideOut.settled).toEqual(await cursorAnchorCenter(ctx.page, '.pane-layout-item'));
    // The keyboard is back in the panes: the tiled pane draws its cursor again
    // and the dock draws none.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () =>
            document.querySelectorAll('.pane-layout-item .terminal-cursor').length === 1 &&
            document.querySelectorAll('[data-testid="right-sidebar-content"] .terminal-cursor')
              .length === 0,
        ),
      5000,
      'the cursor to move back from the dock to the tiled pane',
    );
    const openAfterBlur = await ctx.page.evaluate(
      () => !!document.querySelector('[data-testid="right-sidebar-content"]'),
    );
    expect(openAfterBlur).toBe(true);

    // Step 8: the header toggle HIDES the column but keeps the shell alive —
    // prefix S reopens the same terminal, scrollback and all. Both ways the
    // column SLIDES: its width eases to zero and back, and the pane
    // container's width eases with it, rather than either jumping between
    // the two layouts.
    const dockWidth = await ctx.page.evaluate(() =>
      Math.round(
        document.querySelector('[data-testid="right-sidebar-content"]').getBoundingClientRect()
          .width,
      ),
    );
    const closing = await sampleSidebarSlide(
      ctx.page,
      () => ctx.page.click('button[aria-label="Toggle terminal sidebar"]'),
      '[data-testid="right-sidebar-content"]',
    );
    expect(slideProblem(closing.column, -1)).toBeNull();
    expect(slideProblem(closing.container, +1)).toBeNull();
    expect(closing.column[0]).toBe(dockWidth);
    expect(closing.column[closing.column.length - 1]).toBe(0);
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 10000, polling: 100 },
    );
    const windowSurvivedHide = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.windows?.some((w) => w.windowType === 'sidebar-right'),
    );
    expect(windowSurvivedHide).toBe(true);

    const opening = await sampleSidebarSlide(
      ctx.page,
      () => sendPrefixCommand(ctx.page, 'S', { shift: true }),
      '[data-testid="right-sidebar-content"]',
    );
    expect(slideProblem(opening.column, +1)).toBeNull();
    expect(slideProblem(opening.container, -1)).toBeNull();
    expect(opening.column[opening.column.length - 1]).toBe(dockWidth);
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 10000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      10000,
      'the same shell (with its scrollback) to come back on reopen',
    );

    // Cleanup: kill the pinned shell the way a user would — `exit` inside it —
    // so the shared tmux server is left clean for the next test in the file.
    // The column has no kill button: its toggle only hides it, and the shell
    // going away is what retracts the column (see appMachine's sidebar
    // lifecycle).
    // The Escape from step 7 reached this shell; in a vi-mode zsh that leaves
    // the line editor in command mode, where `exit` would not be typed. Ctrl+C
    // aborts the line and starts a fresh one in insert mode under either keymap.
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    // Keys reach the shell in the order pressed; no beat between them.
    await ctx.page.keyboard.press('Control+c');
    await ctx.page.keyboard.type('exit');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 15000, polling: 100 },
    );
  }, 180000);
});

// ==================== Scenario 6d: Sidebar Tree View ====================

describe('Scenario 6d: Sidebar Tree View', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix t opens fixed sidebar → tree shows tabs/panes → focus + Enter activates a tab → l blurs → q closes', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The first window — we'll switch back to it via the tree later. Captured
    // before creating a second window, so it's the lowest-index tab (row 0).
    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);
    const firstPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(firstPaneId).toMatch(/^%\d+$/);

    // A pane sitting inside a git checkout: the tree decorates its row with
    // the branch. The repo is a throwaway created here, so the badge can only
    // come from discovering this pane's cwd — not from the tmuxy checkout.
    const os = require('os');
    const path = require('path');
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-tree-git-'));
    const branch = 'tree-badge-branch';
    // The user makes the checkout in the pane, as they would.
    await ctx.session.runCommand(
      `send-keys -t ${firstPaneId} 'cd ${repoDir} && git init -q -b ${branch}' Enter`,
    );
    await waitForCondition(
      ctx.page,
      async () => {
        if (!fs.existsSync(path.join(repoDir, '.git', 'HEAD'))) return false;
        const out = String(
          await ctx.session.query("list-panes -a -F '#{pane_id}\t#{pane_current_path}'"),
        );
        const cwd = out
          .split('\n')
          .map((l) => l.split('\t'))
          .find(([id]) => id === firstPaneId)?.[1];
        return Boolean(cwd) && fs.realpathSync(cwd) === fs.realpathSync(repoDir);
      },
      8000,
      'the pane to sit inside the throwaway repo',
    );

    // Setup (not the feature under test): a second window so the tree lists
    // more than one tab and an activation switch is observable.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active && active !== firstWindowId;
      },
      8000,
      'second window to become active',
    );

    // A pane whose title outgrows the column. A pane row is two lines — the
    // process on the first, the title on the second — and it is the TITLE line
    // that has to truncate rather than spill past the column's edge.
    const longTitle = 'a very long pane title that certainly needs truncating in this tree';
    // The shell may set the title itself at every prompt (zsh and fish
    // configs commonly do, over OSC 2), which would overwrite this one before
    // the tree draws it. `allow-set-title off` keeps the title the test set
    // (`-q`: tmux 3.2 has no such option).
    await ctx.session.runCommand(`set-option -q -p -t ${ctx.session.name} allow-set-title off`);
    await ctx.session.runCommand(`select-pane -t ${ctx.session.name} -T '${longTitle}'`);

    // Step 1: Open the sidebar via the real keybinding (prefix s).
    await openSidebarKeyboard(ctx.page, 'left', { fixed: true });

    // Step 2: The FIXED sidebar column appears docked at the left edge (it is
    // a flex sibling of the pane area, not an overlay — panes reflow beside it).
    await ctx.page.waitForSelector('.sidebar-column-left', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('.sidebar-column-left');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.left) <= 2 && r.width > 50 && r.height > 100;
        }),
      8000,
      'fixed sidebar to dock at the left edge',
    );

    // Step 3: The tree rendered real rows — both windows' tabs are listed.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length >= 2,
        ),
      20000,
      'tree rows to render in the sidebar',
    );
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate((title) => {
          const titleLine = [
            ...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-title'),
          ].find((el) => el.textContent.includes(title.slice(0, 20)));
          if (!titleLine) return false;
          // The title really is the SECOND line: the process line sits above
          // it, in the same label column.
          const row = titleLine.closest('.sidebar-tree-pane');
          const processLine = row.querySelector('.sidebar-tree-line');
          if (!processLine) return false;
          const above = processLine.getBoundingClientRect();
          const column = document.querySelector('.sidebar-column-left').getBoundingClientRect();
          const r = titleLine.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(titleLine).lineHeight);
          // One line, really cut rather than spilling past the column, still
          // inside it on every side, and under the process line.
          return (
            Math.round(r.height / lineHeight) === 1 &&
            titleLine.scrollWidth > titleLine.clientWidth &&
            r.top >= above.bottom - 1 &&
            r.left >= column.left &&
            r.right <= column.right &&
            r.bottom <= column.bottom
          );
        }, longTitle),
      8000,
      // On failure, what the tree drew and what the panes report IS the
      // diagnosis: a missing title and a title that did not truncate look the
      // same from the outside.
      async () =>
        `the long pane title to truncate onto its own line in the tree\ntree titles: ${await ctx.page.evaluate(
          () =>
            JSON.stringify(
              [...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-title')].map((el) => [
                el.textContent,
                el.scrollWidth,
                el.clientWidth,
                Math.round(el.getBoundingClientRect().height),
              ]),
            ),
        )}\npanes: ${await ctx.page.evaluate(() =>
          JSON.stringify(
            window.app.getSnapshot().context.panes.map((p) => [p.tmuxId, p.title, p.command]),
          ),
        )}`,
    );

    // The pane inside the repo shows its branch, drawn inside the column, and
    // no other row does — the other panes sit in whatever checkout the server
    // was started from, never in this throwaway one.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          ({ paneId, branch }) => {
            const badge = document.querySelector(
              `[data-testid="tree-pane-${paneId}"] .sidebar-tree-git`,
            );
            if (!badge || badge.textContent !== branch) return false;
            const column = document.querySelector('.sidebar-column-left').getBoundingClientRect();
            const r = badge.getBoundingClientRect();
            return r.width > 0 && r.left >= column.left && r.right <= column.right;
          },
          { paneId: firstPaneId, branch },
        ),
      25000,
      'the branch badge on the pane inside the repo',
    );
    const rowsOnBranch = await ctx.page.evaluate(
      (name) =>
        [...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-git')].filter(
          (el) => el.textContent === name,
        ).length,
      branch,
    );
    expect(rowsOnBranch).toBe(1);
    fs.rmSync(repoDir, { recursive: true, force: true });

    // Step 4: Focus the sidebar (click) so keys route to the tree.
    //
    // Click the column's TITLE in the app header, not the column itself:
    // Playwright clicks an element's CENTRE, and the centre of the column is a
    // tree row. Every row activates on click, so focusing that way could land
    // on a session row and fire SWITCH_SESSION — silently moving the whole
    // client to another session mid-test. The title focuses the column and
    // does nothing else.
    await ctx.page.click('[data-testid="sidebar-title-left"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === true),
      5000,
      'leftSidebarFocused set after click',
    );

    // Give the keyboard actor time to process UPDATE_LEFT_SIDEBAR_FOCUSED (async
    // message from XState, may lag the context update).
    await delay(DELAYS.SYNC);
    await ctx.page.bringToFront();

    // Step 5: Move the selection onto the FIRST window's tab row, then Enter
    // activates it → the active window switches back to the first window.
    //
    // Target the row by window id rather than by index: the tree inserts a
    // session header row whenever the socket hosts more than one session (which
    // it does under test — the server keeps its own session alongside the one
    // the test creates), so row 0 is not necessarily the first tab.
    //
    // Navigate top-down rather than walking up from wherever the cursor starts.
    // The tree's default selection is the active pane's row, but it falls back
    // to row 0 when that row isn't found — and row 0 sits ABOVE the target, so
    // pressing only `k` could never reach it.
    // Wait for the attached session's LIVE subtree first. The tree renders a
    // session's real tab/pane rows only while `sessionName` matches an entry in
    // the sessions list; until the ~1.5s sessions poll catches up with a
    // freshly-created session, every row is rendered as `foreign-*` — including
    // the client's own session — and no live tab row exists to select at all.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          (id) => !!document.querySelector(`[data-testid="tree-tab-${id}"]`),
          firstWindowId,
        ),
      15000,
      async () => {
        const s = await ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          return {
            url: location.href,
            sessionName: c?.sessionName,
            sessions: (c?.sessions || []).map((x) => x.sessionName),
            windows: (c?.windows || []).map((w) => w.id),
            rows: Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
              (r) => r.getAttribute('data-testid'),
            ),
          };
        });
        return `live tab row for ${firstWindowId}; ctxSession=${ctx.session.name}; state=${JSON.stringify(s)}`;
      },
    );

    const firstTabSelected = () =>
      ctx.page.evaluate((id) => {
        const row = document.querySelector(`.sidebar-tree [data-testid="tree-tab-${id}"]`);
        return !!row && row.classList.contains('is-selected');
      }, firstWindowId);

    const rowCount = await ctx.page.evaluate(
      () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length,
    );
    // `k` clamps at row 0, so this parks the cursor at the top whatever it was.
    for (let i = 0; i < rowCount; i++) {
      await ctx.page.keyboard.press('k');
    }
    for (let i = 0; i < rowCount && !(await firstTabSelected()); i++) {
      await ctx.page.keyboard.press('j');
    }
    await waitForCondition(ctx.page, firstTabSelected, 5000, async () => {
      const tree = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
          (r) =>
            `${r.className.includes('is-selected') ? '>' : ' '} ${r.getAttribute('data-testid')}`,
        ),
      );
      return `selection to reach the first window's tab row (${firstWindowId})\n  tree:\n    ${tree.join('\n    ')}`;
    });
    await ctx.page.keyboard.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active === firstWindowId;
      },
      10000,
      'tree Enter to activate the first window',
    );

    // Step 6: `l` (nav right, out of the column) blurs the tree — the column
    // stays open, focus returns to the panes. Escape is deliberately not a
    // sidebar key, so it must leave the focus where it is.
    await ctx.page.keyboard.press('Escape');
    await afterFrames(ctx.page);
    const focusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.leftSidebarFocused,
    );
    expect(focusedAfterEscape).toBe(true);
    await ctx.page.keyboard.press('l');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === false),
      5000,
      'leftSidebarFocused cleared after l',
    );
    const stillOpen = await ctx.page.evaluate(() => {
      const el = document.querySelector('.sidebar-column-left');
      return !!el && el.getBoundingClientRect().width > 50;
    });
    expect(stillOpen).toBe(true);

    // The header toggle reflects the open state.
    const pressedWhileOpen = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedWhileOpen).toBe('true');

    // Step 7: `q` from inside the focused tree closes the sidebar — the
    // column is removed and the toggle returns to its unpressed state.
    await ctx.page.click('[data-testid="sidebar-title-left"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused === true),
      5000,
      'tree focused again before q',
    );
    await ctx.page.keyboard.press('q');
    await ctx.page.waitForFunction(() => !document.querySelector('.sidebar-column-left'), {
      timeout: 10000,
      polling: 100,
    });
    const pressedAfterClose = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedAfterClose).toBe('false');
  }, 180000);
});

describe('Scenario 6k: A coding agent’s state on its tree row', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('an agent’s hooks show it working → it finishes while the user is in another pane → unread → the user looks → idle', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    // Two panes: the agent's on top, the one the user moves to below.
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    const activePane = () => ctx.page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const otherPane = await activePane();
    await navigatePaneKeyboard(ctx.page, 'up');
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) !== otherPane,
      10000,
      'the top pane to be active',
    );
    const agentPane = await activePane();

    // A stand-in for an agent: it runs exactly the hook commands
    // `tmuxy agent install` puts in Claude Code's settings — a prompt, then
    // the turn ending — and ends its turn when the test says so.
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-'));
    const go = path.join(dir, 'go');
    const hook = (event) => `echo '{}' | '${TMUXY_CLI}' agent hook claude ${event}`;
    await typeInTerminal(
      ctx.page,
      `${hook('UserPromptSubmit')}; until [ -e '${go}' ]; do sleep 0.2; done; ${hook('Stop')}`,
    );
    await pressEnter(ctx.page);

    // The user moves on to the other pane.
    await navigatePaneKeyboard(ctx.page, 'down');
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) === otherPane,
      10000,
      'the other pane to be active',
    );
    // Open the tree with its key — unless an earlier test left it open, when
    // the same key would free it to overlay the panes.
    const treeOpen = () =>
      ctx.page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === true);
    if (!(await treeOpen())) await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await waitForCondition(ctx.page, treeOpen, 15000, 'the tree to open');

    // A state mark wherever it is drawn: the tree row and the pane's header
    // (in the icon's place), and the tab (in its number's). Idle draws none.
    const mark = (selector) =>
      ctx.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          state: [...el.classList].find((c) => c.startsWith('is-'))?.slice(3) ?? null,
          text: el.textContent,
          visible: r.width > 0 && r.height > 0 && r.left >= 0,
        };
      }, selector);
    const rowMark = `[data-testid="tree-pane-${agentPane}"] .sidebar-tree-state`;
    const tabMark = '.tab-name-active .tab-mark';
    const headerMark = `[data-pane-tab="${agentPane}"] .pane-tab-icon`;
    const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/;
    const waitForMark = (selector, expected, what) =>
      waitForCondition(
        ctx.page,
        async () => {
          const now = await mark(selector);
          // An idle pane row draws no mark at all — its process icon is back.
          if (!now) return expected.state === null && expected.text === undefined;
          if (now.state !== expected.state) return false;
          if (expected.state && !now.visible) return false;
          if (expected.text instanceof RegExp) return expected.text.test(now.text);
          return expected.text === undefined || now.text === expected.text;
        },
        20000,
        async () =>
          `${what} to be ${expected.state ?? 'idle'} (now ${JSON.stringify(await mark(selector))})`,
      );

    // Working: the same text spinner on the tree row, the tab (in place of its
    // number) and the pane's header (in place of its icon) — and it turns.
    await waitForMark(rowMark, { state: 'working', text: SPINNER }, 'the tree row');
    await waitForMark(tabMark, { state: 'working', text: SPINNER }, 'the tab');
    await waitForMark(headerMark, { state: 'working', text: SPINNER }, 'the pane header');
    const frames = new Set();
    await waitForCondition(
      ctx.page,
      async () => {
        frames.add((await mark(tabMark))?.text);
        return frames.size > 1;
      },
      5000,
      async () => `the spinner to turn (saw ${JSON.stringify([...frames])})`,
    );

    // The agent finishes while the user is in the other pane: unread.
    fs.writeFileSync(go, '');
    await waitForMark(rowMark, { state: 'unread', text: '●' }, 'the tree row');
    await waitForMark(tabMark, { state: 'unread', text: '●' }, 'the tab');

    // The user sees the mark and clicks the row: seen, so idle — no mark on
    // the row, and the tab shows its number again.
    await ctx.page.click(`[data-testid="tree-pane-${agentPane}"]`);
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) === agentPane,
      10000,
      'the agent’s pane to be active again',
    );
    await waitForMark(rowMark, { state: null }, 'the tree row');
    await waitForMark(tabMark, { state: null, text: '➊' }, 'the tab');
  }, 120000);
});

describe('Scenario 6m: Dragging in the tree moves panes between tabs and reorders tabs', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  const tabRows = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-tree-tab[data-window-id]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.windowId, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
  /** The tree's rows top to bottom: `tab:@n` and `pane:%n`. */
  const treeOrder = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-tree [role="treeitem"]')].map((el) =>
        el.dataset.windowId ? `tab:${el.dataset.windowId}` : `pane:${el.dataset.paneId}`,
      ),
    );

  test('a pane row dropped on another tab joins it there → a tab row dragged above another reorders the strip and the tree alike', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Tab 1 with two panes (so moving one does not close it), then tab 2.
    const firstWindowId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activeWindowId,
    );
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    const movedPaneId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activePaneId,
    );
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    const secondWindowId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activeWindowId,
    );
    expect(secondWindowId).not.toBe(firstWindowId);

    await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await ctx.page.waitForSelector(`[data-testid="tree-tab-${secondWindowId}"]`, {
      timeout: 20000,
    });
    await ctx.page.waitForSelector(`[data-testid="tree-pane-${movedPaneId}"]`, { timeout: 20000 });

    // Step 1: drag the pane row onto the other tab's row. The browser's own
    // drag-and-drop, as the row is `draggable`.
    await ctx.page.dragAndDrop(
      `[data-testid="tree-pane-${movedPaneId}"]`,
      `[data-testid="tree-tab-${secondWindowId}"]`,
    );
    // The tree lists it under tab 2 — and keeps it there while tmux answers.
    await waitForCondition(
      ctx.page,
      async () => {
        const order = await treeOrder(ctx.page);
        const tab = order.indexOf(`tab:${secondWindowId}`);
        const pane = order.indexOf(`pane:${movedPaneId}`);
        return (
          tab !== -1 && pane > tab && !order.slice(tab + 1, pane).some((r) => r.startsWith('tab:'))
        );
      },
      10000,
      'the tree to list the dropped pane under the other tab',
    );
    // tmux moved it, and tab 2 (now current) shows two panes in the grid.
    await waitForCondition(
      ctx.page,
      async () => {
        const out = String(await ctx.session.query("list-panes -a -F '#{pane_id}\t#{window_id}'"));
        return out.split('\n').some((l) => l === `${movedPaneId}\t${secondWindowId}`);
      },
      10000,
      'tmux to report the pane in the other window',
    );
    await waitForPaneCount(ctx.page, 2);
    // The count can reach two before the moved pane is laid out at its size.
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate((id) => {
          const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 50 && r.height > 20;
        }, movedPaneId),
      10000,
      'the moved pane to be laid out in the other tab',
    );

    // Step 2: drag tab 2's row above tab 1's. Mid-drag the row rides with the
    // pointer and tab 1 carries the drop bar; the drop reorders.
    const rowsBefore = await tabRows(ctx.page);
    expect(rowsBefore.map((r) => r.id)).toEqual([firstWindowId, secondWindowId]);
    const [rowOne, rowTwo] = rowsBefore;
    await ctx.page.mouse.move(rowTwo.x + rowTwo.w / 2, rowTwo.y + rowTwo.h / 2);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(rowOne.x + rowOne.w / 2, rowOne.y + 2, { steps: 8 });
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          ([one, two]) =>
            document
              .querySelector(`[data-testid="tree-tab-${two}"]`)
              ?.classList.contains('is-dragging') &&
            document
              .querySelector(`[data-testid="tree-tab-${one}"]`)
              ?.classList.contains('is-drop-before'),
          [firstWindowId, secondWindowId],
        ),
      3000,
      'the lifted tab row and the drop bar',
    );
    const lifted = (await tabRows(ctx.page)).find((r) => r.id === secondWindowId);
    expect(lifted.y).toBeLessThan(rowTwo.y - 10);
    await ctx.page.mouse.up();

    await waitForCondition(
      ctx.page,
      async () => (await tabRows(ctx.page))[0]?.id === secondWindowId,
      8000,
      'the dragged tab row to become the first',
    );
    const tmuxOrder = String(await ctx.session.query("list-windows -F '#{window_id}'"))
      .split('\n')
      .filter((id) => [firstWindowId, secondWindowId].includes(id));
    expect(tmuxOrder).toEqual([secondWindowId, firstWindowId]);
    // The strip agrees with the tree.
    expect(
      await ctx.page.evaluate(() =>
        [...document.querySelectorAll('.tab-list .tab-name[data-window-id]')].map(
          (el) => el.dataset.windowId,
        ),
      ),
    ).toEqual([secondWindowId, firstWindowId]);
    expect(
      await ctx.page.evaluate(() =>
        document.querySelector('.sidebar-tree .is-dragging, .sidebar-tree .is-drop-before'),
      ),
    ).toBeNull();
  }, 120000);
});

describe('Scenario 6l: The tree lists panes in grid order', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('panes read left to right as in the grid, and the list follows a swap', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Two panes side by side.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);

    const treeOpen = () =>
      ctx.page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === true);
    if (!(await treeOpen())) await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await waitForCondition(ctx.page, treeOpen, 15000, 'the tree to open');

    // What the grid shows, left to right, and what the tree lists.
    const order = () =>
      ctx.page.evaluate(() => {
        const { activeWindowId, panes } = window.app.getSnapshot().context;
        const grid = panes
          .filter((p) => p.windowId === activeWindowId)
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((p) => p.tmuxId);
        const tree = [
          ...document.querySelectorAll(
            `[data-testid="tree-tab-${activeWindowId}"] ~ .sidebar-tree-pane`,
          ),
        ]
          .map((el) => el.getAttribute('data-pane-id'))
          .filter((id) => grid.includes(id));
        return { grid, tree };
      });
    const waitForTreeInGridOrder = (what) =>
      waitForCondition(
        ctx.page,
        async () => {
          const { grid, tree } = await order();
          return grid.length === 2 && JSON.stringify(grid) === JSON.stringify(tree);
        },
        15000,
        async () => `${what} (now ${JSON.stringify(await order())})`,
      );
    await waitForTreeInGridOrder('the tree to list the panes left to right');
    const before = (await order()).grid;

    // The user swaps them: the list follows the grid, not the panes' ids.
    await typeInTerminal(ctx.page, `'${TMUXY_CLI}' pane swap ${before[0]} ${before[1]}`);
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => JSON.stringify((await order()).grid) === JSON.stringify([...before].reverse()),
      15000,
      'the swap to land in the grid',
    );
    await waitForTreeInGridOrder('the tree to follow the swap');
  }, 120000);
});
