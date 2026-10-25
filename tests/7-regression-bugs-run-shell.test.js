/**
 * Regression Tests for Production Bugs (run-shell output)
 *
 * What a `run-shell` the client sends prints, and how it ended, reaches the
 * snackbar — never a tmux mode the UI does not draw.
 */

const {
  createTestContext,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  waitForCondition,
  tmuxCommandKeyboard,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

// ==================== Scenario: run-shell output reaches the snackbar ====================
//
// tmux 3.4 opens a `run-shell`'s output, and the "returned 1" of a failure, in
// view-mode on the current pane instead of handing it to the client that ran
// it. tmuxy draws no view-mode: the pane looked untouched while every key went
// to the mode, one of them opened a prompt on the control client, and tmux
// answered none of tmuxy's commands after that. Later versions hand the output
// to the client, which showed nothing. The server now relays it (monitor
// `run_shell` module) on every version. The tmux-3.4 CI job runs this file.

describe('Scenario: what a run-shell prints reaches the snackbar, on every tmux', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a failing run-shell is an error with its output, a quiet one a notice, and the pane keeps taking keys', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    const paneId = await ctx.session.getActivePaneId();

    const notices = (role) =>
      page.$$eval(`[data-testid="snackbar-item"][role="${role}"] .snackbar-text`, (items) =>
        items.map((i) => i.textContent),
      );
    const waitForNotice = (role, text) =>
      waitForCondition(
        page,
        async () => (await notices(role)).some((t) => t.includes(text)),
        15000,
        async () =>
          `a ${role} notice with ${text} (shown: ${JSON.stringify({
            status: await notices('status'),
            alert: await notices('alert'),
          })})`,
      );

    // A script that prints and fails, as a binding's would.
    const failed = `RUN_FAILED_${Date.now()}`;
    await tmuxCommandKeyboard(page, `run-shell "echo ${failed}; exit 3"`);
    await waitForNotice('alert', failed);
    const alert = (await notices('alert')).find((t) => t.includes(failed));
    expect(alert).toContain('3');

    // The pane is in no mode, and keys still reach its shell.
    expect(tmuxExec(`display-message -p -t ${paneId} '#{pane_in_mode}'`).trim()).toBe('0');
    await typeInTerminal(page, 'echo AFTER_RUN_SHELL');
    await pressEnter(page);
    await waitForTerminalText(page, 'AFTER_RUN_SHELL', 15000, { notOnLineWith: 'echo' });

    // Output from one that succeeds is a notice; formats are still tmux's.
    const said = `RUN_SAID_${Date.now()}`;
    await tmuxCommandKeyboard(page, `run-shell "echo ${said} #{session_name}"`);
    await waitForNotice('status', said);
    const notice = (await notices('status')).find((t) => t.includes(said));
    expect(notice).toBe(`${said} ${ctx.session.name}`);
    expect(tmuxExec(`display-message -p -t ${paneId} '#{pane_in_mode}'`).trim()).toBe('0');
  }, 90000);
});
