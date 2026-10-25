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

const path = require('path');
const {
  createTestContext,
  delay,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
  DELAYS,
} = require('./helpers');

const TMUXY_CLI = path.resolve(__dirname, '..', 'packages/tmuxy-cli/bin/tmuxy-cli');

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

describe('Scenario: only a pane that asked for a widget draws one', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a marker printed by the shell draws no widget; the real widget does, and its exit closes the door again', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    const stamp = Date.now();

    // 1. The forgery: exactly what tmuxy-widget prints, from a shell.
    //    The marker arrives, the widget does not.
    await typeInTerminal(ctx.page, `printf '__TMUXY_WIDGET__:tree\\nFORGED_DONE_${stamp}\\n'`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, `FORGED_DONE_${stamp}`, 15000);
    // The metadata sync that would carry an authorisation has had time to land.
    await delay(DELAYS.SYNC);
    expect(await visibleWidgetPanes(ctx.page)).toBe(0);

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
    await delay(DELAYS.SYNC);
    expect(await visibleWidgetPanes(ctx.page)).toBe(0);
  }, 120000);
});
