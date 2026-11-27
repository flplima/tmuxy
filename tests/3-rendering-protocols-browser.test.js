/**
 * Rendering & Protocols E2E Tests ($BROWSER)
 *
 * A program in a pane opens a URL the way Claude Code, `gh` and Python's
 * `webbrowser` do: it runs `$BROWSER <url>`. tmuxy points BROWSER at its
 * `browser` script, which hands the URL to the app, and the URL opens in the
 * user's browser — a new tab here — not on the machine the pane runs on.
 * Right after the person used the app it opens at once; otherwise the app
 * shows the URL with an Open button.
 */

const { describeE2E, runCommand, waitForCondition } = require('./helpers');
const { tmuxOlderThan } = require('./helpers/tmux-socket');

/** What the browser shows for the URLs this suite opens: no network needed. */
async function serveExampleCom(context) {
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>example</title>opened' }),
  );
}

/** The tab a program in a pane opened, once it has left about:blank. */
async function openedTab(popup) {
  await popup.waitForURL(/^https:\/\/example\.com\//, { timeout: 10000 });
  return popup.url();
}

describeE2E('$BROWSER: a program in a pane opens a URL', {}, (ctx) => {
  /**
   * `display-message` reaches a control-mode client as `%message` from tmux
   * 3.4: before that the script says so and fails, so the program prints its
   * own fallback.
   */
  async function refusedOnOldTmux() {
    if (!tmuxOlderThan(3, 4)) return false;
    await runCommand(ctx.page, '"$BROWSER" https://example.com/x; echo OLD-$?', 'OLD-1');
    return true;
  }

  test('right after the person typed in the pane, the URL opens in a new tab', async () => {
    await ctx.setupPage();
    if (await refusedOnOldTmux()) return;
    const context = ctx.page.context();
    await serveExampleCom(context);

    // Typing the command is the interaction: its Enter is the last key.
    const popup = context.waitForEvent('page', { timeout: 15000 });
    await runCommand(ctx.page, '"$BROWSER" https://example.com/x && echo SENT-OK', 'SENT-OK');
    const tab = await popup;
    expect(await openedTab(tab)).toBe('https://example.com/x');
    // Opened directly: no notice was needed.
    expect(await ctx.page.locator('[data-testid="snackbar-open-url"]').count()).toBe(0);
    await tab.close();
  });

  test('with nobody using the app, the URL waits in a notice the person opens', async () => {
    await ctx.setupPage();
    if (await refusedOnOldTmux()) return;
    const context = ctx.page.context();
    await serveExampleCom(context);
    const pages = context.pages().length;

    // Past the activation window by the time the script runs.
    await runCommand(
      ctx.page,
      'sleep 6; "$BROWSER" https://example.com/later; echo LATER-$?',
      'LATER-0',
      30000,
    );
    const open = ctx.page.locator('[data-testid="snackbar-open-url"]');
    await waitForCondition(
      ctx.page,
      async () => (await open.count()) === 1 && (await open.isVisible()),
      5000,
      'the notice with an Open button',
    );
    const notice = ctx.page.locator('[data-testid="snackbar-item"]', { has: open });
    expect(await notice.textContent()).toContain('https://example.com/later');
    const box = await notice.boundingBox();
    expect(box && box.width > 0 && box.height > 0).toBe(true);
    // Nothing opened on its own: the app opens or shows a URL, never both,
    // and it decided when the notice appeared.
    expect(context.pages().length).toBe(pages);

    const popup = context.waitForEvent('page', { timeout: 10000 });
    await open.click();
    const tab = await popup;
    expect(await openedTab(tab)).toBe('https://example.com/later');
    await waitForCondition(
      ctx.page,
      async () => (await open.count()) === 0,
      5000,
      'the notice to go once opened',
    );
    await tab.close();
  });

  test('a link a pane must not open is refused, and the program is told', async () => {
    await ctx.setupPage();
    await runCommand(ctx.page, '"$BROWSER" file:///etc/passwd; echo REFUSED-$?', 'REFUSED-2');
    expect(await ctx.page.locator('[data-testid="snackbar-open-url"]').count()).toBe(0);
  });
});
