/**
 * The scroll view on a phone (docs/COPY-MODE.md, "Scroll view"): a finger
 * dragged down opens it, a tap on it brings the keyboard up as a tap on the
 * live screen does, and the first thing typed closes it and lands at the
 * prompt. A phone keyboard types text into the hidden input
 * (infra/dom/mobileKeyboard.ts), with no keydown before it, so that is how
 * this suite types once the view is open. The layout itself is
 * tests/12-touch.test.js.
 *
 * As in the other touch suites, every assertion is about what is on screen.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  keyRowCentre,
  swipe,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const {
  describeE2E,
  waitForTerminalText,
  waitForCopyMode,
  getCopyModeState,
  waitForCondition,
} = require('./helpers');

describeE2E(
  'Phone width (390px) with a touchscreen: the scroll view',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('a tap on the open scroll view brings the keyboard up, and what is typed closes the view and lands at the prompt', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);
      const keyboardUp = () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT');
      const keyboardKey = await keyRowCentre(ctx.page, '⌨');

      // History to scroll back through, then the keyboard away.
      await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
      await waitForCondition(ctx.page, keyboardUp, 5000, 'the ⌨ key to open the keyboard');
      await typeOnVirtualKeyboard(ctx.page, 'for i in $(seq 0 79); do echo "line-$i"; done');
      await ctx.page.keyboard.press('Enter');
      await waitForTerminalText(ctx.page, 'line-79', 20000);
      await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
      await waitForCondition(
        ctx.page,
        async () => !(await keyboardUp()),
        5000,
        'the ⌨ key to put the keyboard away',
      );

      // A finger dragged down opens the view.
      const pane = await boxOf(ctx.page, '.pane-active [role="log"]');
      const x = pane.left + pane.width / 2;
      await swipe(ctx.page, x, pane.top + pane.height * 0.25, pane.top + pane.height * 0.85);
      expect((await waitForCopyMode(ctx.page, true, 15000)).mode).toBe('scroll');
      const view = await boxOf(ctx.page, '[data-testid="scrollback-terminal"]');
      expect(view.width).toBeGreaterThan(0);
      expect(view.height).toBeGreaterThan(0);

      // 1. A tap on the view brings the keyboard up, and the view stays open.
      const tapAt = await boxOf(ctx.page, '.pane-active .pane-content');
      await ctx.page.touchscreen.tap(x, tapAt.top + tapAt.height / 2);
      await waitForCondition(
        ctx.page,
        keyboardUp,
        5000,
        'a tap on the scroll view to bring the keyboard up',
      );
      expect((await getCopyModeState(ctx.page))?.mode).toBe('scroll');

      // 2. What the keyboard types closes the view and goes to the prompt.
      await ctx.page.keyboard.insertText('echo SCROLL_VIEW_CLOSED');
      await waitForCopyMode(ctx.page, false, 5000);
      await ctx.page.keyboard.press('Enter');
      await waitForTerminalText(ctx.page, 'SCROLL_VIEW_CLOSED', 20000, { notOnLineWith: 'echo' });
      const live = await boxOf(ctx.page, '.pane-active .pane-live-screen');
      expect(live.height).toBeGreaterThan(0);
    }, 120000);
  },
);
