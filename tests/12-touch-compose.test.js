/**
 * The phone's compose sheet as a thumb uses it
 * (components/phone/ComposeSheet.tsx): ⌨ on the key row, held, opens the whole
 * screen to write in with the phone keyboard's own corrections; Send pastes
 * everything written into the pane at once; dragged down by its bar, the sheet
 * closes, sends nothing and keeps the draft. The key row itself is
 * tests/12-touch-keys.test.js.
 *
 * As there, every assertion is about what is on screen.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  drag,
  hold,
  keyRowCentre,
  waitForPhoneGrid,
} = require('./helpers/phone');
const {
  describeE2E,
  getTerminalText,
  waitForTerminalText,
  waitForCondition,
} = require('./helpers');

describeE2E(
  'Phone width (390px) with a touchscreen: ⌨ held opens the compose sheet',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('a hold on ⌨ opens the sheet over the screen; two lines written reach the shell as one paste on Send; a drag down by the bar closes it, sends nothing and keeps the draft', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);

      const boxOf = (selector) =>
        ctx.page.evaluate((sel) => {
          const el = document.querySelector(sel);
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
        }, selector);
      const SHEET = '[role="dialog"][aria-label="Write to the pane"]';
      const sheetOpen = async () => (await boxOf(SHEET)) !== null;
      const tapBox = (b) => ctx.page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      const holdKeyboardKey = async () =>
        hold(
          ctx.page,
          await keyRowCentre(ctx.page, '⌨'),
          sheetOpen,
          'a hold on ⌨ to open the sheet',
        );
      const writing = () =>
        waitForCondition(
          ctx.page,
          () =>
            ctx.page.evaluate(
              () => document.activeElement?.getAttribute('aria-label') === 'Text to send',
            ),
          5000,
          'the sheet’s text box to take the focus',
        );
      const closed = (why) =>
        waitForCondition(ctx.page, async () => !(await sheetOpen()), 5000, why);

      // 1. Held, ⌨ opens the sheet over the whole screen, and the release puts
      //    the focus in its text box, with the phone keyboard's help on.
      await holdKeyboardKey();
      const shown = await boxOf(SHEET);
      expectOnScreen(shown, 'the compose sheet');
      expect(shown.top).toBeLessThan(40);
      expect(shown.bottom).toBeGreaterThan(PHONE.height - 40);
      await writing();
      expect(
        await ctx.page.evaluate(() => {
          const area = document.activeElement;
          return {
            autocorrect: area.getAttribute('autocorrect'),
            spellcheck: area.spellcheck,
            fontSize: parseFloat(getComputedStyle(area).fontSize),
          };
        }),
      ).toEqual({ autocorrect: 'on', spellcheck: true, fontSize: 17 });

      // 2. Two lines, then Send: the sheet goes and both reach the shell's
      //    line at once. ⏎ on the key row runs them.
      const marker = `COMPOSE${Date.now().toString(36)}`;
      await typeOnVirtualKeyboard(ctx.page, `echo ${marker}_ONE`);
      await ctx.page.keyboard.press('Enter');
      await typeOnVirtualKeyboard(ctx.page, `echo ${marker}_TWO`);
      await tapBox(await boxOf('.compose-sheet-send'));
      await closed('Send to close the sheet');
      await waitForTerminalText(ctx.page, `echo ${marker}_TWO`);
      const enter = await keyRowCentre(ctx.page, '⏎');
      await ctx.page.touchscreen.tap(enter.x, enter.y);
      await waitForTerminalText(ctx.page, `${marker}_ONE`, 15000, { notOnLineWith: 'echo' });
      await waitForTerminalText(ctx.page, `${marker}_TWO`, 15000, { notOnLineWith: 'echo' });

      // 3. A draft dragged away by the bar: the sheet closes, nothing reaches
      //    the pane, and the next hold finds the draft as it was left.
      await holdKeyboardKey();
      await writing();
      const draft = `${marker}_DRAFT`;
      await typeOnVirtualKeyboard(ctx.page, draft);
      const bar = await boxOf('[data-testid="compose-sheet-bar"]');
      expectOnScreen(bar, 'the sheet’s bar');
      const x = bar.left + bar.width / 2;
      await drag(ctx.page, { x, y: bar.top + 6 }, { x, y: bar.top + 420 });
      await closed('a drag down to close the sheet');
      expect(await getTerminalText(ctx.page)).not.toContain(draft);

      await holdKeyboardKey();
      expect(
        await ctx.page.evaluate(() => document.querySelector('.compose-sheet-input')?.value),
      ).toBe(draft);
      await tapBox(await boxOf('.compose-sheet-button:not(.compose-sheet-send)'));
      await closed('Cancel to close the sheet');
      expect(await getTerminalText(ctx.page)).not.toContain(draft);
    }, 120000);
  },
);
