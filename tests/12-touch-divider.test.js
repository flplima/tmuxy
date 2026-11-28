/**
 * The handle along the top of the phone's bottom sheet, by a finger
 * (components/phone/PhoneDivider.tsx, domain/phoneSplit.ts). Dragged down it
 * zooms the terminal — the panes, their headers and tmux's status line as one
 * picture, from the top-left corner — as far as the sheet gives room, and the
 * zoom is kept for the next load. Dragged back up it settles on the
 * terminal's own size; up past that, the sheet rises over the terminal and
 * the keys, which keep their size and fade to dark, and covers the screen
 * under the tab strip; down again, it goes back under the keys.
 *
 * Every assertion is about boxes on screen.
 */

const { PHONE, phoneContext, drag, boxOf, waitForPhoneGrid } = require('./helpers/phone');
const { describeE2E, waitForCondition } = require('./helpers');

/** What the split draws: the handle, the picture, the keys, the sheet. */
const splitState = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      bar: box('[data-testid="phone-divider"]'),
      grid: box('.phone-pty .pane-container'),
      line: box('.phone-pty .tmux-status-bar'),
      top: box('[data-testid="phone-top"]'),
      keys: box('.key-row'),
      lower: box('.phone-lower'),
      tabs: box('.phone-tabs'),
      strip: box('[data-testid="phone-tab-strip"]'),
      fade: Number(getComputedStyle(document.querySelector('[data-testid="phone-top"]')).opacity),
    };
  });

describeE2E(
  'Phone width (390px) with a touchscreen: the bottom sheet under the keys',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('a drag down zooms the terminal as one picture and is kept for the next load; back up it settles; up past it raises the sheet over the fading terminal; down lowers it', async () => {
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

      // 0. At rest: the terminal at its own size, the sheet and its handle
      //    right under the keys, the tab bar right under the handle.
      const rest = await splitState(page);
      expect(rest.bar.top).toBeCloseTo(rest.keys.bottom, 0);
      expect(rest.tabs.top).toBeCloseTo(rest.bar.bottom, 0);
      const zoomOf = (s) => s.grid.height / rest.grid.height;

      // 1. Down 150px: the picture grows by the height dragged, from its
      //    top-left corner, tmux's line at the grid's scale; the keys under it,
      //    the bottom view 150px shorter.
      await dragBar(150);
      await until((s) => zoomOf(s) > 1.3 && s.bar.top > rest.bar.top + 140, 'the drag to zoom');
      const zoomed = state;
      const zoom = zoomOf(zoomed);
      expect(zoomed.grid.left).toBeCloseTo(rest.grid.left, 0);
      expect(zoomed.grid.top).toBeCloseTo(rest.grid.top, 0);
      expect(zoomed.line.height).toBeCloseTo(rest.line.height * zoom, 0);
      expect(zoomed.keys.top).toBeGreaterThanOrEqual(zoomed.line.bottom - 1);
      expect(zoomed.lower.height).toBeCloseTo(
        rest.lower.height - (zoomed.bar.top - rest.bar.top),
        0,
      );

      // 2. Kept for the next load: the same zoom, the bar where it was left.
      await page.reload();
      await waitForPhoneGrid(page);
      await until(
        (s) =>
          Math.abs(s.grid.height - zoomed.grid.height) < 1 &&
          Math.abs(s.bar.top - zoomed.bar.top) < 1,
        'the zoom kept',
      );

      // 3. Back up a little past where it started: the terminal at its own
      //    size, the sheet back where it rests (a lift that short goes back).
      await dragBar(-(zoomed.bar.top - rest.bar.top) - 10);
      await until(
        (s) =>
          Math.abs(s.grid.height - rest.grid.height) < 1 && Math.abs(s.bar.top - rest.bar.top) < 1,
        'the own size',
      );

      // 4. Up from its own size: the sheet rises over the terminal and the
      //    keys, which keep their size and fade out, and covers the screen
      //    under the tab strip.
      await dragBar(-300);
      await until(
        (s) => s.fade === 0 && Math.abs(s.lower.top - s.strip.bottom) < 1,
        'the sheet over the page',
      );
      expect(state.top.height).toBeCloseTo(rest.top.height, 0);
      expect(state.grid.height).toBeCloseTo(rest.grid.height, 0);
      expect(state.bar.top).toBeCloseTo(state.lower.top, 0);
      expect(state.lower.bottom).toBeCloseTo(PHONE.height, 0);
      expect(state.tabs.top).toBeCloseTo(state.bar.bottom, 0);

      // 5. Down again: back under the keys, the page as at rest.
      await dragBar(300);
      await until(
        (s) => s.fade === 1 && Math.abs(s.lower.top - rest.lower.top) < 1,
        'the sheet back under the keys',
      );
      expect(state.grid.height).toBeCloseTo(rest.grid.height, 0);
      expect(state.keys.top).toBeCloseTo(rest.keys.top, 0);
    }, 120000);
  },
);
