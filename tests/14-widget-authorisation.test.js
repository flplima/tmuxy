/**
 * Which panes may draw a widget.
 *
 * SEC-18. The `__TMUXY_WIDGET__:` marker is pane OUTPUT: a crafted file under
 * `cat`, a commit message in `git log`, an ssh MOTD can all print it. Only
 * `tmuxy-widget` — which tags the pane with `@tmuxy-pane-widget` out of band
 * before printing — may turn a pane into a widget, and once it has exited the
 * tag goes with it, so the same pane cannot be talked back into a widget by
 * what its shell prints next.
 */

const {
  waitForSettled,
  TMUXY_CLI,
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

/** Widget panes drawn with a real box, not merely mounted. */
function visibleWidgetPanes(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('[role=group][aria-label^="Widget pane"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 20 && r.height >= 20;
      }).length,
  );
}

/**
 * No widget, after a forged marker: tmux holds no `@tmuxy-pane-widget` for
 * the pane, and with the app caught up (the marker came before the line just
 * seen, in the same stream) none is drawn.
 */
async function expectNoWidget(page) {
  const paneId = await page.evaluate(() => window.app.view().activePaneId);
  expect(tmuxExec(`show-options -pqv -t ${paneId} @tmuxy-pane-widget`)).toBe('');
  await waitForSettled(page);
  expect(await visibleWidgetPanes(page)).toBe(0);
}

describeE2E('Scenario: only a pane that asked for a widget draws one', {}, (ctx) => {
  test('a marker printed by the shell draws no widget; the real widget does, and its exit closes the door again', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    const stamp = Date.now();

    // 1. The forgery: exactly what tmuxy-widget prints, from a shell.
    //    The marker arrives, the widget does not.
    await typeInTerminal(ctx.page, `printf '__TMUXY_WIDGET__:tree\\nFORGED_DONE_${stamp}\\n'`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, `FORGED_DONE_${stamp}`, 15000);
    await expectNoWidget(ctx.page);

    // 2. The real thing, in the same pane.
    await typeInTerminal(ctx.page, `clear; ${TMUXY_CLI} widget tree`);
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await visibleWidgetPanes(ctx.page)) === 1,
      30000,
      'the real widget to be drawn',
    );

    // 3. Leaving the widget clears the tag, and the pane is a shell again.
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => (await visibleWidgetPanes(ctx.page)) === 0,
      15000,
      'the widget to go when it exits',
    );
    await waitForShellPrompt(ctx.page);

    // 4. ...and that shell's output still authorises nothing.
    await typeInTerminal(ctx.page, `printf '__TMUXY_WIDGET__:tree\\nFORGED_AGAIN_${stamp}\\n'`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, `FORGED_AGAIN_${stamp}`, 15000);
    await expectNoWidget(ctx.page);
  }, 120000);
});
