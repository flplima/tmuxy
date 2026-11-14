/**
 * Debug > Copy Trace… shows the last actions of the trace, redacted, and
 * copies exactly what it showed. The trace is the suite server's own
 * (`--trace`), made by this test's actions: synthetic, never a user's.
 */

const {
  describeE2E,
  waitForShellPrompt,
  waitForCondition,
  splitPaneKeyboard,
  waitForPaneCount,
} = require('./helpers');
const { clickMenuItem } = require('./helpers/menus');

describeE2E('Scenario: a redacted trace from the Debug menu', {}, (ctx) => {
  test('the preview shows the redacted trace, and Copy copies exactly that', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    // An action of the user's, for the trace to hold.
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);

    await clickMenuItem(page, ['Debug', 'Copy Trace…']);
    const preview = page.locator('[data-testid="trace-share-preview"]');
    await preview.waitFor({ state: 'visible', timeout: 15000 });
    const shown = await waitForCondition(
      page,
      async () => {
        const text = await preview.textContent();
        return text && text.includes('"layer"') ? text : null;
      },
      15000,
      'the preview to show trace lines',
    );
    // The session's name is in the server's trace, and not in what is shown.
    expect(shown).not.toContain(ctx.session.name);
    expect(shown).not.toMatch(/\/home\/|\/tmp\//);

    await page.locator('button', { hasText: /^Copy \d+ lines$/ }).click();
    const copied = await waitForCondition(
      page,
      () => page.evaluate(() => window.__tmuxyLastClipboard?.text ?? null),
      10000,
      'the trace to be copied',
    );
    expect(copied).toBe(shown);
  }, 90000);
});
