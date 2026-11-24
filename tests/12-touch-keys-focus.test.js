/**
 * A tap on the phone key row never changes who has the keyboard
 * (components/phone/KeyRow.tsx): the hidden input keeps the focus through
 * ctrl, tab and an arrow, and a key typed after them reaches the pane with
 * the latch applied. WebKit moves the focus on a touch whatever a handler
 * prevents, so the row puts it back; the layout itself is tests/12-touch.test.js.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  keyRowCentre,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { describeE2E, waitForCondition } = require('./helpers');

describeE2E(
  'Phone width (390px) with a touchscreen: the key row leaves the keyboard where it is',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('ctrl, tab and an arrow keep the focus on the input, and the latch lands on the next typed key', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);

      const tap = async (label) => {
        const at = await keyRowCentre(ctx.page, label);
        await ctx.page.touchscreen.tap(at.x, at.y);
      };
      const focusedTag = () => ctx.page.evaluate(() => document.activeElement?.tagName);
      const screenLines = () =>
        ctx.page.evaluate(() =>
          [...document.querySelectorAll('.pane-active .terminal-line')]
            .map((l) => l.textContent.trimEnd())
            .filter((t) => t.length > 0),
        );
      // Chromium keeps the focus where it is; WebKit moves it to the touched
      // button unless the touch was stopped at touchstart. Do what WebKit does.
      await ctx.page.evaluate(() => {
        window.addEventListener('touchstart', (e) => {
          if (!e.defaultPrevented) e.target.closest('button')?.focus();
        });
      });

      await tap('⌨');
      await waitForCondition(
        ctx.page,
        async () => (await focusedTag()) === 'INPUT',
        5000,
        'the ⌨ key to open the keyboard',
      );

      // A short prompt, so a typed line never wraps.
      await typeOnVirtualKeyboard(ctx.page, "PS1='$ '");
      await ctx.page.keyboard.press('Enter');
      await waitForCondition(
        ctx.page,
        async () => (await screenLines()).at(-1) === '$',
        5000,
        'the short prompt',
      );
      await typeOnVirtualKeyboard(ctx.page, 'echo LATCH_KEPT');
      await waitForCondition(
        ctx.page,
        async () => (await screenLines()).at(-1) === '$ echo LATCH_KEPT',
        5000,
        'the typed text on the prompt line',
      );

      // ctrl latched, locked, let go; then tab and an arrow: each leaves the
      // keyboard on the input, and the typed text is where it was.
      for (const label of ['ctrl', 'ctrl', 'ctrl', 'tab', '↓']) {
        await tap(label);
        expect(await focusedTag()).toBe('INPUT');
      }
      expect((await screenLines()).at(-1)).toBe('$ echo LATCH_KEPT');

      // A latched ctrl takes the next typed key: ctrl+u clears the line.
      await tap('ctrl');
      expect(await focusedTag()).toBe('INPUT');
      await typeOnVirtualKeyboard(ctx.page, 'u');
      await waitForCondition(
        ctx.page,
        async () => (await screenLines()).at(-1) === '$',
        5000,
        'ctrl+u to clear the line',
      );
    }, 120000);
  },
);
