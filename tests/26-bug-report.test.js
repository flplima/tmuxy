/**
 * Debug > Copy Bug Report Snippet puts the setup on the clipboard as
 * Markdown: versions, platform and settings, and nothing a terminal holds.
 * The clipboard is read from what the app last wrote, since a headless
 * browser grants no clipboard permission.
 */

const { describeE2E, waitForShellPrompt, waitForCondition } = require('./helpers');
const { clickMenuItem } = require('./helpers/menus');

describeE2E('Scenario: a bug report snippet from the Debug menu', {}, (ctx) => {
  test('the snippet names the versions and settings, and no session, tab or command', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const session = ctx.session.name;

    await clickMenuItem(page, ['Debug', 'Copy Bug Report Snippet']);
    const copied = await waitForCondition(
      page,
      () => page.evaluate(() => window.__tmuxyLastClipboard?.text ?? null),
      10000,
      'the snippet to be copied',
    );

    expect(copied).toContain('### Environment');
    expect(copied).toMatch(/^- tmuxy \d+\.\d+\.\d+ \(web\)$/m);
    // tmux answered the version query itself.
    expect(copied).toMatch(/^- tmux \d+\.\d+[a-z]?$/m);
    expect(copied).toMatch(/^- \d+ tab\(s\), \d+ pane\(s\)$/m);
    expect(session).toBeTruthy();
    expect(copied).not.toContain(session);
    expect(copied).not.toMatch(/bash|zsh|\/home\//);
  }, 90000);
});
