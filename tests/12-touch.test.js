/**
 * Phone width, finger only
 *
 * The smallest viewport any test opens is 800x600 and no browser context in
 * the suite has ever had `hasTouch` set — so on a real phone three things run
 * completely uncovered: the hidden input that IS the virtual keyboard
 * (utils/mobileKeyboard.ts, whose `focusMobileInput` returns immediately
 * unless `navigator.maxTouchPoints > 0`), the swipe that opens the scroll
 * view, and a tab strip that has to fit in 400 CSS pixels.
 *
 * At this width the interesting failures are geometric: something overflows
 * the screen, or is drawn where no finger can reach it. Every assertion here
 * is therefore about boxes on screen, not about elements existing.
 */

const { createOwnBrowserContext } = require('./helpers/own-browser');
const {
  getBrowser,
  waitForTerminalText,
  getTerminalText,
  waitForCopyMode,
  getCopyModeState,
  createWindowKeyboard,
  waitForWindowCount,
  waitForCondition,
  delay,
  DELAYS,
} = require('./helpers');

const PHONE = { width: 400, height: 780 };

/** Swipe one finger from `fromY` to `toY`, the way a thumb moves. */
async function swipe(page, x, fromY, toY, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const dy = (toY - fromY) / steps;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: fromY }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: fromY + dy * i }],
    });
    await delay(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Type on the virtual keyboard — into whatever the tap put the focus on. */
async function typeOnVirtualKeyboard(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(15);
  }
}

/** Every box the user should be able to reach has to be inside the screen. */
/**
 * Thrown rather than `expect`ed so the geometry reaches the log whole: jest's
 * object diff prints the line that differs and elides the rest, which for a
 * layout that only misbehaves on another machine's fonts leaves "right: false"
 * and no way to tell what produced it.
 */
function expectOnScreen(box, label, width = PHONE.width, diag = {}) {
  const fail = (what) => {
    throw new Error(`${label} ${what}\n${JSON.stringify({ box, ...diag }, null, 2)}`);
  };
  if (!(box.width > 0 && box.height > 0)) fail('is not visible');
  if (!(box.left >= -1)) fail(`starts off the left edge (${box.left})`);
  if (!(box.right <= width + 1)) fail(`runs past the right edge (${box.right} > ${width})`);
}

describe('Phone width (400px) with a touchscreen', () => {
  const ctx = createOwnBrowserContext({
    label: 'a touch-enabled Chromium context',
    // Chromium is the browser the whole suite already needs; a missing one is
    // a broken environment, not a skip.
    openBrowser: async () => (await getBrowser())._browser,
    contextOptions: { viewport: PHONE, hasTouch: true, deviceScaleFactor: 2 },
  });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  // The browser is the suite-wide shared one; closing it would take the rest
  // of the run with it. Only this suite's own page and context are released.
  afterAll(async () => {
    if (ctx.page) await ctx.page.close().catch(() => {});
    if (ctx.context) await ctx.context.close().catch(() => {});
    ctx.browser = null;
  }, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('tap opens the keyboard, a swipe opens history, and the tabs are reachable', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    // 1. Nothing runs off the side of the screen. A 400px-wide page that
    //    scrolls sideways is the whole class of phone layout bug, and it costs
    //    one number to rule out.
    const measureLayout = () =>
      ctx.page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
        };
        const ctx = window.app?.getSnapshot()?.context;
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          pane: box(document.querySelector('.pane-active [role="log"]')),
          tabs: box(document.querySelector('.tab-list')),
          // What the grid was sized from, for a failure to be readable: the
          // client's target against what tmux actually reports, and the panes
          // it reports it for.
          grid: ctx && {
            containerWidth: ctx.containerWidth,
            charWidth: ctx.charWidth,
            totalWidth: ctx.totalWidth,
            targetCols: ctx.targetCols,
            totalHeight: ctx.totalHeight,
            targetRows: ctx.targetRows,
            readOnly: ctx.readOnly ?? null,
            sidebarMotion: ctx.sidebarMotion ?? null,
            leftSidebar: ctx.leftSidebarOpen ?? null,
            rightSidebar: ctx.rightSidebarOpen ?? null,
            panes: (ctx.panes ?? []).map((p) => `${p.tmuxId} ${p.width}x${p.height}`),
          },
        };
      });
    // Following the viewport is a round trip, not a reflow: the client asks
    // tmux for the columns it measured and redraws when tmux says it resized.
    // On a slow machine that took longer than the five seconds this used to
    // allow, and the sample caught the terminal still at the session's opening
    // 200 columns — `targetCols: 41, totalWidth: 200` in the failure. So it
    // waits for the grid to BE the one asked for, which is the thing the
    // geometry below is about, and waits as long as the rest of the suite does.
    let layout = await measureLayout();
    const fits = (l) =>
      l &&
      l.pane &&
      l.grid &&
      l.grid.totalWidth === l.grid.targetCols &&
      l.pane.right <= PHONE.width + 1 &&
      l.docScrollWidth <= PHONE.width + 1;
    const layoutDeadline = Date.now() + 20000;
    while (Date.now() < layoutDeadline && !fits(layout)) {
      await delay(100);
      layout = await measureLayout();
    }
    expect(layout.docScrollWidth).toBeLessThanOrEqual(PHONE.width + 1);
    expectOnScreen(layout.pane, 'the terminal', PHONE.width, { grid: layout.grid });
    expectOnScreen(layout.tabs, 'the tab strip', PHONE.width, { grid: layout.grid });
    // A terminal squeezed to nothing is "on screen" too; it has to be usable.
    expect(layout.pane.height).toBeGreaterThan(200);

    // 2. The virtual keyboard. A tap — not a click — is what opens it: the
    //    hidden input is only focused for a device with touch points, so on
    //    this path alone does the phone get a keyboard at all.
    const target = { x: layout.pane.left + layout.pane.width / 2, y: layout.pane.top + 40 };
    await ctx.page.touchscreen.tap(target.x, target.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.activeElement;
          return !!el && el.tagName === 'INPUT' && getComputedStyle(el).position === 'fixed';
        }),
      5000,
      'the tap to open the keyboard (focus the hidden input)',
    );

    // What is typed on it reaches the shell and comes back on screen — and
    // `waitForTerminalText` only counts text in a box the user can see.
    await typeOnVirtualKeyboard(ctx.page, 'echo TOUCH_KBD_OK');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'TOUCH_KBD_OK', 20000);

    // Tapping the same pane again puts the keyboard away, which is the only
    // way to get the screen back on a phone.
    await ctx.page.touchscreen.tap(target.x, target.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.activeElement;
          return !el || el.tagName !== 'INPUT';
        }),
      5000,
      'a second tap to dismiss the keyboard',
    );

    // 3. The scroll view. Print more history than the screen holds, then drag
    //    it down with a finger the way every other app scrolls.
    await ctx.page.touchscreen.tap(target.x, target.y);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
      5000,
      'the keyboard to come back for the second command',
    );
    await typeOnVirtualKeyboard(ctx.page, 'for i in $(seq 0 79); do echo "line-$i"; done');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'line-79', 20000);
    const lowestLine = (text) => {
      const numbers = [...text.matchAll(/line-(\d+)/g)].map((m) => Number(m[1]));
      return numbers.length > 0 ? Math.min(...numbers) : null;
    };
    const liveLowest = lowestLine(await getTerminalText(ctx.page));
    // The screen cannot hold 80 lines at this height, so the early ones have
    // scrolled off — they are what the swipe has to bring back.
    expect(liveLowest).toBeGreaterThan(0);

    const pane = await ctx.page.evaluate(() => {
      const r = document.querySelector('.pane-active [role="log"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, top: r.top, height: r.height };
    });
    // Finger DOWN = look further back, the natural-scrolling convention.
    await swipe(ctx.page, pane.x, pane.top + pane.height * 0.25, pane.top + pane.height * 0.85);
    const scroll = await waitForCopyMode(ctx.page, true, 15000);
    expect(scroll.mode).toBe('scroll');

    // The view is not just in the state machine: it covers the pane, inside
    // the screen, showing rows that had scrolled off.
    const view = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback-terminal"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.terminal-line')]
        .filter((l) => {
          const b = l.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight;
        })
        .map((l) => l.textContent);
      return {
        box: { left: r.left, right: r.right, width: r.width, height: r.height },
        rows,
      };
    });
    expect(view).not.toBeNull();
    expectOnScreen(view.box, 'the scroll view');
    expect(view.rows.length).toBeGreaterThan(5);
    // …and it brought back rows the live screen had already lost: that is
    // what the swipe was for.
    expect(lowestLine(view.rows.join('\n'))).toBeLessThan(liveLowest);

    await ctx.page.keyboard.press('Escape');
    await waitForCopyMode(ctx.page, false, 15000);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // 4. The tab strip. Two tabs in 400px is where a strip overflows or the
    //    tap lands on the wrong one. The second window is setup; switching
    //    back to the first with a finger is the feature.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2, 15000);
    await delay(DELAYS.SYNC);

    const tabs = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.tab-name:not(.tab-add)')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-window-id'),
          active: el.classList.contains('tab-name-active'),
          left: r.left,
          right: r.right,
          top: r.top,
          width: r.width,
          height: r.height,
        };
      }),
    );
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expectOnScreen(tab, `tab ${tab.id}`);
      // A tap target below this is not reachable with a thumb.
      expect({ id: tab.id, tall: tab.height >= 20 }).toEqual({ id: tab.id, tall: true });
      expect({ id: tab.id, wide: tab.width >= 40 }).toEqual({ id: tab.id, wide: true });
    }
    expect(tabs[1].active).toBe(true);

    await ctx.page.touchscreen.tap(
      tabs[0].left + tabs[0].width / 2,
      tabs[0].top + tabs[0].height / 2,
    );
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate((id) => {
          const el = [...document.querySelectorAll('.tab-name')].find(
            (t) => t.getAttribute('data-window-id') === id,
          );
          return !!el && el.classList.contains('tab-name-active');
        }, tabs[0].id),
      15000,
      'tapping the first tab to switch back to it',
    );

    // The window it switched to is the one that ran the commands, still
    // rendered and still on screen — the last line it printed, not a tab that
    // switched to an empty grid.
    await waitForTerminalText(ctx.page, 'line-79', 15000);
  }, 240000);
});
