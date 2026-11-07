/**
 * The bar between the phone's terminal and its bottom view, by a finger
 * (components/PhoneDivider.tsx, utils/phoneSplit.ts). Dragged down it zooms
 * the terminal — the panes, their headers and tmux's status line as one
 * picture, from the top-left corner — as far as the bottom view gives room,
 * and the zoom is kept for the next load. Dragged back up it settles on the
 * terminal's own size; up past that, the terminal and the keys fold away and
 * the bottom view takes the screen; down again, they come back.
 *
 * Every assertion is about boxes on screen.
 */

const { PHONE, usePhoneContext, drag, boxOf, waitForPhoneGrid } = require('./helpers/phone');
const { waitForCondition } = require('./helpers');

/** What the split draws: the bar, the picture, the keys, the bottom view. */
const splitState = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const c = window.app.getSnapshot().context;
    return {
      zoom: c.phoneZoom,
      collapsed: c.phoneCollapsed,
      bar: box('[data-testid="phone-divider"]'),
      grid: box('.phone-pty .pane-container'),
      line: box('.phone-pty .tmux-status-bar'),
      top: box('[data-testid="phone-top"]'),
      keys: box('.key-row'),
      lower: box('.phone-lower'),
      tabs: box('.phone-tabs'),
      zoomKey: document.querySelector('[data-key-row="zoom"]')?.getAttribute('aria-pressed'),
    };
  });

describe('Phone width (390px) with a touchscreen: the bar under the keys', () => {
  const ctx = usePhoneContext(PHONE);

  test('a drag down zooms the terminal as one picture and is kept for the next load; back up it settles; up past it folds the terminal away; down brings it back', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await waitForPhoneGrid(ctx.page);
    const page = ctx.page;
    let state = null;
    const until = (check, what) =>
      waitForCondition(
        page,
        async () => check((state = await splitState(page))),
        10000,
        () => `${what} (last: ${JSON.stringify(state)})`,
      );
    const dragBar = async (dy) => {
      const bar = await boxOf(page, '[data-testid="phone-divider"]');
      const from = { x: bar.left + bar.width / 2, y: bar.top + bar.height / 2 };
      await drag(page, from, { x: from.x, y: from.y + dy });
    };

    // 0. At rest: the bar right under the keys, the tab bar right under it.
    const rest = await splitState(page);
    expect(rest.zoom).toBe(1);
    expect(rest.bar.top).toBeCloseTo(rest.keys.bottom, 0);
    expect(rest.tabs.top).toBeCloseTo(rest.bar.bottom, 0);

    // 1. Down 150px: the picture grows by the height dragged, from its
    //    top-left corner, tmux's line at the grid's scale; the keys under it,
    //    the bottom view 150px shorter, the zoom key lit.
    await dragBar(150);
    await until((s) => s.zoom > 1.3 && s.bar.top > rest.bar.top + 140, 'the drag to zoom');
    const zoom = state.zoom;
    expect(state.grid.left).toBeCloseTo(rest.grid.left, 0);
    expect(state.grid.top).toBeCloseTo(rest.grid.top, 0);
    expect(state.grid.height).toBeCloseTo(rest.grid.height * zoom, 0);
    expect(state.line.height).toBeCloseTo(rest.line.height * zoom, 0);
    expect(state.keys.top).toBeGreaterThanOrEqual(state.line.bottom - 1);
    expect(state.lower.height).toBeCloseTo(rest.lower.height - (state.bar.top - rest.bar.top), 0);
    expect(state.zoomKey).toBe('true');

    // 2. Kept for the next load: the same zoom, the bar where it was left.
    const barTop = state.bar.top;
    await page.reload();
    await waitForPhoneGrid(page);
    await until((s) => s.zoom === zoom && Math.abs(s.bar.top - barTop) < 1, 'the zoom kept');

    // 3. Back up past where it started: the terminal at its own size.
    await dragBar(-300);
    await until((s) => s.zoom === 1 && Math.abs(s.bar.top - rest.bar.top) < 1, 'the own size');

    // 4. Up from its own size: the terminal and the keys fold away, the
    //    bottom view the whole screen under the bar.
    await dragBar(-90);
    await until((s) => s.collapsed && s.top.height === 0, 'the terminal folded away');
    expect(state.bar.top).toBeCloseTo(0, 0);
    expect(state.lower.bottom).toBeCloseTo(PHONE.height, 0);
    expect(state.tabs.top).toBeCloseTo(state.bar.bottom, 0);

    // 5. Down again: back at its own size, as at rest.
    await dragBar(70);
    await until(
      (s) => !s.collapsed && Math.abs(s.grid.height - rest.grid.height) < 1,
      'the terminal back',
    );
    expect(state.keys.top).toBeCloseTo(rest.keys.top, 0);
  }, 120000);
});
