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

/** The texts of the snackbar's notices of `role` (`status` or `alert`). */
const notices = (page, role) =>
  page.$$eval(`[data-testid="snackbar-item"][role="${role}"] .snackbar-text`, (items) =>
    items.map((i) => i.textContent),
  );

/** Wait for a notice of `role` whose text includes `text`. */
const waitForNotice = (page, role, text) =>
  waitForCondition(
    page,
    async () => (await notices(page, role)).some((t) => t.includes(text)),
    15000,
    async () =>
      `a ${role} notice with ${text} (shown: ${JSON.stringify({
        status: await notices(page, 'status'),
        alert: await notices(page, 'alert'),
      })})`,
  );

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

    // A script that prints and fails, as a binding's would.
    const failed = `RUN_FAILED_${Date.now()}`;
    await tmuxCommandKeyboard(page, `run-shell "echo ${failed}; exit 3"`);
    await waitForNotice(page, 'alert', failed);
    const alert = (await notices(page, 'alert')).find((t) => t.includes(failed));
    expect(alert).toContain('3');

    // The pane is in no mode, and keys still reach its shell.
    expect(tmuxExec(`display-message -p -t ${paneId} '#{pane_in_mode}'`).trim()).toBe('0');
    await typeInTerminal(page, 'echo AFTER_RUN_SHELL');
    await pressEnter(page);
    await waitForTerminalText(page, 'AFTER_RUN_SHELL', 15000, { notOnLineWith: 'echo' });

    // Output from one that succeeds is a notice; formats are still tmux's.
    const said = `RUN_SAID_${Date.now()}`;
    await tmuxCommandKeyboard(page, `run-shell "echo ${said} #{session_name}"`);
    await waitForNotice(page, 'status', said);
    const notice = (await notices(page, 'status')).find((t) => t.includes(said));
    expect(notice).toBe(`${said} ${ctx.session.name}`);
    expect(tmuxExec(`display-message -p -t ${paneId} '#{pane_in_mode}'`).trim()).toBe('0');
  }, 90000);

  // A `run-shell -b` is not relayed (it runs on, nobody waits), and what it
  // prints opens tmux's view mode on the current pane — on every version. The
  // UI draws no view mode: every key went to a pager nobody saw, and `:`
  // opened a prompt on the control client that stalled tmux. The server now
  // closes a view mode no terminal client is looking at and says so. And what
  // a command typed at the prompt prints (`show-messages`, `list-keys`) is
  // answered to a control client in the reply, where nothing showed it.
  test('a view mode tmux opens for a background run-shell is closed with a notice, and show-messages at the prompt is shown', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    const paneId = await ctx.session.getActivePaneId();

    const viewed = `RUN_VIEWED_${Date.now()}`;
    await tmuxCommandKeyboard(page, `run-shell -b "echo ${viewed}"`);
    await waitForNotice(page, 'status', `tmux opened a view in pane ${paneId}; closed it`);
    await waitForCondition(
      page,
      () => tmuxExec(`display-message -p -t ${paneId} '#{pane_mode}'`).trim() === '',
      15000,
      () =>
        `the pane out of view mode (in ${tmuxExec(`display-message -p -t ${paneId} '#{pane_mode}'`).trim()})`,
    );

    // Keys reach the shell again, not the pager.
    await typeInTerminal(page, 'echo AFTER_VIEW_MODE');
    await pressEnter(page);
    await waitForTerminalText(page, 'AFTER_VIEW_MODE', 15000, { notOnLineWith: 'echo' });

    // What a command typed at the prompt prints is a notice, instead of
    // nothing: `display-message -p` prints to the client, so its text is in
    // the reply and never a `%message`; `show-messages` lists the message
    // log, however long, from the top.
    const said = `PROMPT_SAID_${Date.now()}`;
    await tmuxCommandKeyboard(page, `display-message -p "${said}"`);
    await waitForNotice(page, 'status', said);
    const before = await notices(page, 'status');
    await tmuxCommandKeyboard(page, 'show-messages');
    await waitForCondition(
      page,
      async () => (await notices(page, 'status')).some((t) => !before.includes(t) && t.length > 0),
      15000,
      'a notice listing the messages',
    );
    expect(tmuxExec(`display-message -p -t ${paneId} '#{pane_mode}'`).trim()).toBe('');
  }, 90000);
});
