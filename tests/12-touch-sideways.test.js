/**
 * A phone held sideways, finger only
 *
 * The landscape half of the phone layout (utils/phoneLayout.ts): the terminal
 * on the right at the height its 25 rows fit, the tab strip, key row and tree
 * in the column left of it — and, with the keyboard up, the terminal cut
 * short and scrolled so the row being typed on stays in view above it
 * (hooks/usePhoneViewport.ts). The portrait half is tests/12-touch.test.js.
 *
 * As there, every assertion is about boxes on screen.
 */

const { usePhoneContext, typeOnVirtualKeyboard, expectOnScreen } = require('./helpers/phone');
const { waitForCondition, getTerminalText } = require('./helpers');

const SIDEWAYS = { width: 844, height: 390 };

describe('Phone held sideways (844x390) with a touchscreen', () => {
  const ctx = usePhoneContext(SIDEWAYS);

  test('the terminal on the right at the height of its 25 rows; with the keyboard up the row being typed on stays in view', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    const measure = () =>
      ctx.page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const c = window.app?.getSnapshot()?.context;
        return {
          landscape: c?.phoneLandscape ?? null,
          totalHeight: c?.totalHeight,
          rowHeight: c?.charHeight,
          side: box(document.querySelector('.phone-side')),
          keys: box(document.querySelector('.phone-side .key-row')),
          pty: box(document.querySelector('.phone-pty')),
          status: box(document.querySelector('.phone-pty .tmux-status-bar')),
          cursor: box(document.querySelector('.pane-active .terminal-cursor')),
        };
      });

    // 1. Sideways: the chrome in the column on the left, the terminal on the
    //    right, and all of its 25 rows on screen.
    let layout = null;
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return layout.landscape === true && layout.totalHeight === 24 && layout.status !== null;
      },
      20000,
      () => `the sideways layout (last: ${JSON.stringify(layout)})`,
    );
    expectOnScreen(layout.side, 'the side column', SIDEWAYS.width);
    expectOnScreen(layout.pty, 'the terminal', SIDEWAYS.width);
    expect(layout.side.right).toBeLessThanOrEqual(layout.pty.left + 1);
    expect(layout.pty.right).toBeCloseTo(SIDEWAYS.width, 0);
    expect(layout.status.bottom).toBeLessThanOrEqual(SIDEWAYS.height + 1);
    const rowHeight = layout.rowHeight;

    // 2. The key row's ⌨ key opens the keyboard (a tap on the terminal only
    //    focuses the pane); on this phone it takes 200px of the height.
    await ctx.page.touchscreen.tap(layout.pty.left + 60, layout.pty.top + 60);
    const keyboardKey = await ctx.page.evaluate(() => {
      const r = document.querySelector('[data-key-row="⌨"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
      5000,
      'the ⌨ key to open the keyboard',
    );
    await ctx.page.setViewportSize({ width: SIDEWAYS.width, height: 190 });

    // 3. Output pushes the prompt to the bottom row: that row is still in
    //    view, above the keyboard, and the type did not shrink to make room.
    await typeOnVirtualKeyboard(ctx.page, 'seq 60; echo SIDEWAYS_END');
    await ctx.page.keyboard.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => {
        layout = await measure();
        return (
          layout.cursor !== null &&
          layout.cursor.top >= layout.pty.top - 1 &&
          layout.cursor.bottom <= Math.min(layout.pty.bottom, 190) + 1 &&
          (await getTerminalText(ctx.page)).includes('SIDEWAYS_END')
        );
      },
      20000,
      () => `the cursor's row in view above the keyboard (last: ${JSON.stringify(layout)})`,
    );
    expect(layout.rowHeight).toBe(rowHeight);
    expect(layout.landscape).toBe(true);
    expect(layout.keys.bottom).toBeLessThanOrEqual(190 + 1);
  }, 120000);
});
