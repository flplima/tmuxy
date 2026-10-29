/**
 * The phone's key row as a thumb uses it (components/KeyRow.tsx): a prefix
 * key that arms tmux's prefix with one tap and stays lit until the next key,
 * and arrows that repeat while held and hand over to the arrow a finger
 * slides onto. The layout itself is tests/12-touch.test.js.
 *
 * As there, every assertion is about what is on screen.
 */

const {
  PHONE,
  usePhoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  drag,
  hold,
  keyRowCentre,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { waitForTerminalText, waitForCondition } = require('./helpers');

describe('Phone width (390px) with a touchscreen: the prefix key, and arrows that repeat and slide', () => {
  const ctx = usePhoneContext(PHONE);

  test('one tap arms the prefix and lights the key until the next key; a held arrow repeats and a slide hands over', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await waitForPhoneGrid(ctx.page);

    const keyboardKey = await keyRowCentre(ctx.page, '⌨');
    const openKeyboard = async () => {
      await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
      await waitForCondition(
        ctx.page,
        async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
        5000,
        'the ⌨ key to open the keyboard',
      );
    };
    // The lines on screen, trimmed, blank ones dropped.
    const screenLines = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('.pane-active .terminal-line')]
          .map((l) => l.textContent.trimEnd())
          .filter((t) => t.length > 0),
      );
    // The prompt before anything is typed: the last line on screen once the
    // shell has drawn one.
    const fresh = await waitForCondition(
      ctx.page,
      async () => (await screenLines()).at(-1) ?? null,
      15000,
      'the shell prompt',
    );
    // What the prompt line says now: the last line that starts with the
    // prompt. A shell's suggestion of an old command can wrap onto the line
    // below; that tail is not the prompt line.
    const promptLine = async () =>
      (await screenLines()).filter((t) => t.startsWith(fresh)).at(-1) ?? '';
    const prefixKey = () =>
      ctx.page.evaluate(() => {
        const el = document.querySelector('[data-key-row="prefix"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          pressed: el.getAttribute('aria-pressed') === 'true',
          lit: el.classList.contains('is-latched'),
          background: cs.backgroundColor,
          box: {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          },
        };
      });
    const tabCount = () =>
      ctx.page.evaluate(() => document.querySelectorAll('.phone-tab-strip [role="tab"]').length);

    // 1. Two lines of history to walk.
    await openKeyboard();
    await typeOnVirtualKeyboard(ctx.page, 'echo KEYROW_ONE');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'KEYROW_ONE', 15000, { notOnLineWith: 'echo' });
    await typeOnVirtualKeyboard(ctx.page, 'echo KEYROW_TWO');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'KEYROW_TWO', 15000, { notOnLineWith: 'echo' });

    // 2. A held ↑ repeats. One press puts KEYROW_TWO on the line; the repeat
    //    walks on past it, to KEYROW_ONE or whatever older history the shell
    //    has. The hold ends when the line is past KEYROW_TWO.
    const up = await keyRowCentre(ctx.page, '↑');
    await hold(
      ctx.page,
      up,
      async () => {
        const line = await promptLine();
        return line !== fresh && !line.includes('KEYROW_TWO');
      },
      'the held ↑ to repeat past the last history line',
    );
    expect(await promptLine()).not.toContain('KEYROW_TWO');
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => (await promptLine()) === fresh,
      5000,
      'a fresh line',
    );

    // 3. A finger down on ↓ (nothing to go down to) that slides onto ↑ presses
    //    ↑: the last history line, KEYROW_TWO, with no lift in between.
    const down = await keyRowCentre(ctx.page, '↓');
    await drag(ctx.page, down, up, 6);
    await waitForCondition(
      ctx.page,
      async () => (await promptLine()).includes('echo KEYROW_TWO'),
      5000,
      'the slide onto ↑ to bring the last line back',
    );
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => (await promptLine()) === fresh,
      5000,
      'a fresh line',
    );

    // 4. The prefix key: on the row, dark at rest.
    const before = await prefixKey();
    expect(before).not.toBeNull();
    expectOnScreen(before.box, 'the prefix key');
    expect(before.pressed).toBe(false);
    expect(before.lit).toBe(false);

    //    One tap arms the prefix and lights the key in the accent.
    const prefix = await keyRowCentre(ctx.page, 'prefix');
    await ctx.page.touchscreen.tap(prefix.x, prefix.y);
    await waitForCondition(
      ctx.page,
      async () => (await prefixKey()).pressed,
      5000,
      'the prefix to arm',
    );
    const armed = await prefixKey();
    expect(armed.lit).toBe(true);
    expect(armed.background).not.toBe(before.background);
    //    The keyboard stayed up: the key never takes the focus.
    expect(await ctx.page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');

    //    The next key is a prefix binding: `c` opens a tab, and the key goes dark.
    const tabsBefore = await tabCount();
    await typeOnVirtualKeyboard(ctx.page, 'c');
    await waitForCondition(
      ctx.page,
      async () => (await tabCount()) === tabsBefore + 1,
      15000,
      'prefix c to open a tab',
    );
    await waitForCondition(
      ctx.page,
      async () => !(await prefixKey()).pressed,
      5000,
      'the prefix to let go',
    );
    expect((await prefixKey()).background).toBe(before.background);

    // 5. A second tap while armed cancels: dark again, and what is typed next
    //    is text for the shell, not keys for the prefix table. (With the
    //    prefix still armed, the `e` of echo would be eaten as an unbound
    //    prefix key and CANCEL_OK would never print.)
    await ctx.page.touchscreen.tap(prefix.x, prefix.y);
    await waitForCondition(
      ctx.page,
      async () => (await prefixKey()).pressed,
      5000,
      'the prefix to arm again',
    );
    await ctx.page.touchscreen.tap(prefix.x, prefix.y);
    await waitForCondition(
      ctx.page,
      async () => !(await prefixKey()).pressed,
      5000,
      'the second tap to cancel',
    );
    await typeOnVirtualKeyboard(ctx.page, 'echo CANCEL_OK');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'CANCEL_OK', 15000, { notOnLineWith: 'echo' });
    expect(await tabCount()).toBe(tabsBefore + 1);
  }, 180000);
});
