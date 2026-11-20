/**
 * Ctrl+C at an empty shell prompt ends the shell, and with it the pane, or
 * the tab when the pane was the tab's only one. Anywhere else it stays the
 * interrupt: a line with text is cleared, a running program is stopped, and
 * nothing closes (`domain/emptyPrompt.ts`, `TmuxOp.InterruptOrEof`).
 */

const {
  createWindowKeyboard,
  describeE2E,
  getTerminalText,
  getUIPaneCount,
  pressEnter,
  runCommand,
  sendKeyCombo,
  splitPaneKeyboard,
  typeInTerminal,
  waitForCondition,
  waitForPaneCount,
  waitForShellPrompt,
  waitForTerminalText,
} = require('./helpers');

/** The tabs the strip draws. */
function drawnTabs(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('.tab-name[data-window-id]')].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).length,
  );
}

/** The active pane, as the selector its text is read in. */
async function activePaneScope(ctx) {
  return `[data-pane-id="${await ctx.session.getActivePaneId()}"]`;
}

/** Wait until the pane in `scope` sits at a prompt ending in `prompt`, the cursor right after it. */
async function waitForPrompt(page, scope, prompt) {
  await waitForCondition(
    page,
    async () => (await getTerminalText(page, { scope })).trimEnd().endsWith(prompt),
    15000,
    async () =>
      `${scope} to sit at the prompt ${prompt}: ${JSON.stringify((await getTerminalText(page, { scope })).slice(-120))}`,
  );
}

/**
 * Make `shell` the program of the active pane (`exec`, so it is the pane's
 * own shell, not one nested in it), with the prompt `ps1` draws as `prompt`.
 */
async function becomeShell(ctx, shell, ps1, prompt) {
  await typeInTerminal(ctx.page, `exec ${shell}`);
  await pressEnter(ctx.page);
  await ctx.session.waitForForeground(shell.split(' ')[0]);
  await typeInTerminal(ctx.page, `PS1='${ps1}'`);
  await pressEnter(ctx.page);
  await waitForPrompt(ctx.page, await activePaneScope(ctx), prompt);
}

/** A line printed in the first pane, to tell it on screen once the panes beside it are gone. */
async function markFirstPane(ctx) {
  await ctx.setupPage();
  await runCommand(ctx.page, 'echo FIRST_PANE_$((6*7))', 'FIRST_PANE_42');
}

describeE2E('Ctrl+C at an empty prompt', {}, (ctx) => {
  test('bash: clears a typed line and stops a program, then closes the pane, then the tab', async () => {
    const { page } = ctx;
    await markFirstPane(ctx);
    await splitPaneKeyboard(page);
    await becomeShell(ctx, 'bash --norc --noprofile', 'BASH_READY> ', 'BASH_READY>');
    const scope = await activePaneScope(ctx);

    // A line with text: Ctrl+C clears it, and the shell takes the next line
    // whole. EOF there would have left the text on the line.
    await typeInTerminal(page, 'echo NEVER_RUN');
    await waitForTerminalText(page, 'echo NEVER_RUN', 15000, { scope });
    await sendKeyCombo(page, 'Control', 'c');
    await runCommand(page, 'echo CLEARED_$((6*7))', 'CLEARED_42', 20000, { scope });
    expect(await getTerminalText(page, { scope })).not.toContain('NEVER_RUNecho');
    expect(await getUIPaneCount(page)).toBe(2);

    // A program in front: Ctrl+C interrupts it. EOF would leave `sleep` running
    // and the next line waiting behind it.
    await typeInTerminal(page, 'sleep 100');
    await pressEnter(page);
    await ctx.session.waitForForeground('sleep');
    await sendKeyCombo(page, 'Control', 'c');
    await runCommand(page, 'echo STOPPED_$((6*7))', 'STOPPED_42', 20000, { scope });
    expect(await getUIPaneCount(page)).toBe(2);

    // The empty prompt: the shell ends, its pane goes, the tab stays.
    await waitForPrompt(page, scope, 'BASH_READY>');
    await sendKeyCombo(page, 'Control', 'c');
    await waitForPaneCount(page, 1);
    await waitForTerminalText(page, 'FIRST_PANE_42');
    expect(await drawnTabs(page)).toBe(1);

    // A tab's only pane: the tab goes, and the one left is shown.
    await createWindowKeyboard(page);
    // Its shell is up, and draws the cursor a click on the terminal aims at.
    await waitForShellPrompt(page);
    await becomeShell(ctx, 'bash --norc --noprofile', 'TAB_READY> ', 'TAB_READY>');
    expect(await drawnTabs(page)).toBe(2);
    await sendKeyCombo(page, 'Control', 'c');
    await waitForCondition(
      page,
      async () => (await drawnTabs(page)) === 1,
      10000,
      'the tab to close',
    );
    await waitForTerminalText(page, 'FIRST_PANE_42');
  }, 180000);

  test('zsh: closes the pane at an empty prompt', async () => {
    const { page } = ctx;
    await markFirstPane(ctx);
    await splitPaneKeyboard(page);
    // -f: no startup files, so no first-run wizard in the suite's empty home.
    await becomeShell(ctx, 'zsh -f', 'ZSH_READY> ', 'ZSH_READY>');
    await sendKeyCombo(page, 'Control', 'c');
    await waitForPaneCount(page, 1);
    await waitForTerminalText(page, 'FIRST_PANE_42');
    expect(await drawnTabs(page)).toBe(1);
  }, 120000);
});
