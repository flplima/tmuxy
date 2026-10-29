/**
 * One finger on the phone's terminal (hooks/usePaneTouch.ts): a double tap
 * zooms the grid in the browser and a finger pans it; a hold selects the word
 * under it, with Copy and Cancel over the pane; a sideways swipe switches
 * tabs. The layout itself is tests/12-touch.test.js.
 *
 * As there, every assertion is about boxes on screen.
 */

const {
  PHONE,
  usePhoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  swipeSideways,
  hold,
  keyRowCentre,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const {
  waitForTerminalText,
  waitForCopyMode,
  getCopyModeState,
  createWindowKeyboard,
  waitForCondition,
} = require('./helpers');

describe('Phone width (390px) with a touchscreen: zoom, hold and swipe', () => {
  const ctx = usePhoneContext(PHONE);

  test('a double tap zooms the terminal and a finger pans it; a hold selects a word and Copy takes it; a sideways swipe switches tabs', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForPhoneGrid(ctx.page);
    const pane = await boxOf(ctx.page, '.pane-active [role="log"]');
    const centre = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 };

    // Something to select: a word of its own on the screen.
    const keyboardKey = await keyRowCentre(ctx.page, '⌨');
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
      5000,
      'the ⌨ key to open the keyboard',
    );
    await typeOnVirtualKeyboard(ctx.page, 'echo HOLD_WORD_TARGET');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'HOLD_WORD_TARGET', 20000, { notOnLineWith: 'echo' });
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);

    // 1. A double tap zooms the grid in the browser — twice its size, in a
    //    viewport that scrolls — around the point tapped; tmux is told nothing.
    const gridBefore = await boxOf(ctx.page, '.phone-pty .pane-container');
    await ctx.page.touchscreen.tap(centre.x, centre.y);
    await ctx.page.touchscreen.tap(centre.x + 2, centre.y + 2);
    const measureZoom = () =>
      ctx.page.evaluate(() => {
        const v = document.querySelector('.phone-zoom-viewport');
        const grid = document.querySelector('.phone-pty .pane-container').getBoundingClientRect();
        return {
          zoomed: !!document.querySelector('.phone-pty.is-zoomed'),
          scrollLeft: v.scrollLeft,
          scrollWidth: v.scrollWidth,
          clientWidth: v.clientWidth,
          gridWidth: grid.width,
          totalWidth: window.app.getSnapshot().context.totalWidth,
        };
      });
    let zoom = null;
    await waitForCondition(
      ctx.page,
      async () => {
        zoom = await measureZoom();
        return zoom.zoomed && zoom.scrollWidth > zoom.clientWidth + 10;
      },
      5000,
      () => `the double tap to zoom (last: ${JSON.stringify(zoom)})`,
    );
    expect(zoom.gridWidth).toBeCloseTo(gridBefore.width * 2, 0);
    expect(zoom.totalWidth).toBe(80);
    // Tapped in the middle, the view is scrolled to the middle.
    expect(zoom.scrollLeft).toBeGreaterThan(50);
    // A finger pans it.
    const scrollLeftBefore = zoom.scrollLeft;
    await swipeSideways(ctx.page, centre.y, 300, 100);
    await waitForCondition(
      ctx.page,
      async () => (await measureZoom()).scrollLeft > scrollLeftBefore + 20,
      5000,
      'the finger to pan the zoomed grid',
    );
    // The zoom key puts it back — once the pan has come to rest: a tap while
    // the view still flings only stops it, as on any phone.
    let settled = null;
    await waitForCondition(
      ctx.page,
      async () => {
        const now = (await measureZoom()).scrollLeft;
        const still = settled === now;
        settled = now;
        return still;
      },
      10000,
      'the panned view to come to rest',
    );
    const zoomKey = await keyRowCentre(ctx.page, 'zoom');
    await ctx.page.touchscreen.tap(zoomKey.x, zoomKey.y);
    await waitForCondition(
      ctx.page,
      async () => !(await measureZoom()).zoomed,
      5000,
      'the zoom key to unzoom',
    );
    expect((await boxOf(ctx.page, '.phone-pty .pane-container')).width).toBeCloseTo(
      gridBefore.width,
      0,
    );

    // 2. A hold on the word selects it in copy mode, with Copy and Cancel
    //    over the pane; Copy puts it on the clipboard and leaves copy mode.
    const word = await ctx.page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      const line = [...document.querySelectorAll('.pane-active .terminal-line')].find(
        (l) => l.textContent.includes('HOLD_WORD_TARGET') && !l.textContent.includes('echo'),
      );
      const r = line.getBoundingClientRect();
      const col = line.textContent.indexOf('HOLD_WORD_TARGET');
      return { x: r.left + (col + 3) * c.charWidth, y: r.top + r.height / 2 };
    });
    await hold(
      ctx.page,
      word,
      async () => (await getCopyModeState(ctx.page))?.mode === 'copy',
      'the hold to open copy mode on the word',
    );
    let bar = null;
    await waitForCondition(
      ctx.page,
      async () => {
        bar = await boxOf(ctx.page, '.touch-selection-bar');
        return bar !== null && bar.width > 0;
      },
      5000,
      'the Copy / Cancel bar',
    );
    expectOnScreen(bar, 'the selection bar');
    const copyButton = await boxOf(ctx.page, '[data-touch-selection="copy"]');
    await ctx.page.touchscreen.tap(
      copyButton.left + copyButton.width / 2,
      copyButton.top + copyButton.height / 2,
    );
    await waitForCopyMode(ctx.page, false, 10000);
    expect(await boxOf(ctx.page, '.touch-selection-bar')).toBeNull();
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page
          .evaluate(() => navigator.clipboard.readText().catch(() => ''))
          .then((t) => t === 'HOLD_WORD_TARGET'),
      5000,
      'the word on the clipboard',
    );

    // 3. A second tab, and a sideways swipe on the terminal switches between
    //    the two: right brings the previous tab in, left the next.
    await createWindowKeyboard(ctx.page);
    const selectedTab = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('.phone-tab-strip [role="tab"]')].findIndex(
          (t) => t.getAttribute('aria-selected') === 'true',
        ),
      );
    await waitForCondition(ctx.page, async () => (await selectedTab()) === 1, 15000, 'the new tab');
    await swipeSideways(ctx.page, centre.y, 60, 330);
    await waitForCondition(
      ctx.page,
      async () => (await selectedTab()) === 0,
      10000,
      'a swipe to the right to bring the first tab back',
    );
    await waitForTerminalText(ctx.page, 'HOLD_WORD_TARGET', 15000);
    // The slide runs home after the switch; the next one starts from rest.
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => window.app.getSnapshot().context.gesture === null),
      10000,
      'the slide to come to rest',
    );
    await swipeSideways(ctx.page, centre.y, 330, 60);
    await waitForCondition(
      ctx.page,
      async () => (await selectedTab()) === 1,
      10000,
      'a swipe to the left to go on to the second tab',
    );
  }, 240000);
});
