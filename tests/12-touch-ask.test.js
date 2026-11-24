/**
 * A question over a pane (components/AskOverlay.tsx), answered on a phone.
 *
 * The pane under the question claims every finger on it
 * (components/terminal/usePaneTouch.ts): a tap there focuses the pane and
 * puts the keyboard up or away, and the browser's own click is suppressed so
 * the pane cannot take the focus from the hidden input. A tap on one of the
 * question's buttons is the button's, and the answer reaches the script that
 * asked. The question itself is put up the way a script puts it up: `tmuxy
 * pane ask`, typed into the pane's shell.
 *
 * As in the other touch suites, every assertion is about what is on screen.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  keyRowCentre,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const {
  TMUXY_CLI,
  describeE2E,
  getTerminalText,
  waitForTerminalText,
  waitForCondition,
} = require('./helpers');

/** The question's buttons over the active pane, with their boxes, once they are on screen. */
const seenChoices = (page) =>
  page.evaluate(() => {
    const overlay = document.querySelector('.pane-active [data-pane-ask]');
    if (!overlay) return null;
    return [...overlay.querySelectorAll('[data-ask-choice]')].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        text: b.textContent,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
      };
    });
  });

const questionGone = (page) =>
  page.evaluate(() => !document.querySelector('.pane-active [data-pane-ask]'));

describeE2E(
  'Phone width (390px) with a touchscreen: a question over a pane',
  { context: phoneContext(PHONE) },
  (ctx) => {
    /** Ask "Deploy?" in the active pane's shell, and wait for its buttons on screen. */
    const ask = async (tag) => {
      const keyboardKey = await keyRowCentre(ctx.page, '⌨');
      const keyboardUp = () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT');
      if (!(await keyboardUp())) {
        await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
        await waitForCondition(ctx.page, keyboardUp, 5000, 'the ⌨ key to open the keyboard');
      }
      await typeOnVirtualKeyboard(
        ctx.page,
        `a=$(${TMUXY_CLI} pane ask "Deploy?" --choice yes --choice no); echo "${tag}=[$a]"`,
      );
      await ctx.page.keyboard.press('Enter');
      return waitForCondition(
        ctx.page,
        async () => {
          const choices = await seenChoices(ctx.page);
          return choices?.length === 2 && choices.every((c) => c.width > 20 && c.height > 10)
            ? choices
            : null;
        },
        20000,
        async () =>
          `the question and its two choices on screen (the pane shows ${JSON.stringify(
            (await getTerminalText(ctx.page)).slice(-400),
          )})`,
      );
    };

    test('a tap on a choice answers the question, and the script that asked prints it', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);

      const choices = await ask('tapped');
      expect(choices.map((c) => c.text)).toEqual(['1.yes', '2.no']);
      const pane = await boxOf(ctx.page, '.pane-active [role="log"]');
      for (const c of choices) {
        expect(c.y).toBeGreaterThan(pane.top);
        expect(c.y).toBeLessThan(pane.bottom);
      }

      // A finger on "2. no": the button's tap, not the pane's.
      await ctx.page.touchscreen.tap(choices[1].x, choices[1].y);
      await waitForCondition(
        ctx.page,
        () => questionGone(ctx.page),
        10000,
        'the tapped question to leave the screen',
      );
      await waitForTerminalText(ctx.page, 'tapped=[no]', 20000, { notOnLineWith: 'echo' });
    }, 120000);
  },
);
