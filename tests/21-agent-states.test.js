/**
 * An agent's approval dialog is read off its screen: Antigravity has no hook
 * for one, and Claude Code and Codex fire none when it is answered — so the
 * server reads the bottom of every agent pane its hooks have marked
 * (tmuxy-core/src/host/socket_watch/agent_screen.rs).
 *
 * The agent is a shell under the name `claude`, which is all the server goes
 * by: it plays the agent's hook (the pane marked working), draws a dialog,
 * and waits for the answer the way an agent does, on the keyboard. It uses
 * builtins only, so it stays the pane's foreground command throughout, as an
 * agent does while its tools run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  killPaneKeyboard,
} = require('./helpers');
const { tmuxyCli, tmuxRunAsOperator } = require('./helpers/cli');

/** The state mark a pane's header shows, if it shows one. */
async function headerMark(page, paneId) {
  return page.evaluate((id) => {
    const mark = document.querySelector(`[data-pane-tab="${id}"] .pane-state-mark`);
    const box = mark?.getBoundingClientRect();
    if (!mark || !box || box.width === 0) return null;
    return [...mark.classList].find((c) => c.startsWith('is-'))?.slice(3) ?? null;
  }, paneId);
}

/** What a wait reports when it times out: the mark, and the pane's screen. */
async function seen(page, paneId, waitingFor) {
  const mark = await headerMark(page, paneId);
  const screen = await page.evaluate(
    (id) => document.querySelector(`[data-pane-id="${id}"] [role="log"]`)?.textContent ?? '',
    paneId,
  );
  return `${waitingFor}; the header shows ${mark}, the pane ${JSON.stringify(screen.trim().slice(-300))}`;
}

/** A shell that runs as `claude`: what `pane_current_command` reads. */
function fakeAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-agent-'));
  const agent = path.join(dir, 'claude');
  fs.copyFileSync('/bin/bash', agent);
  fs.chmodSync(agent, 0o755);
  return { agent, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describeE2E(
  'Scenario: an agent pane needs the user while its dialog is up, and works on once it is answered',
  {},
  (ctx) => {
    test('a dialog on screen marks the pane needs-input, the answer marks it working again', async () => {
      const { page } = ctx;
      await ctx.setupPage();
      await waitForShellPrompt(page);
      // Two panes, so each has a header that shows its state.
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await waitForShellPrompt(page);
      const paneId = await page.evaluate(() => window.app?.view().activePaneId);
      const { agent, remove } = fakeAgent();
      try {
        // The turn's first hook: the agent is working.
        tmuxyCli(['pane', 'state', 'working', paneId]);
        await waitForCondition(
          page,
          async () => (await headerMark(page, paneId)) === 'working',
          10000,
          () => seen(page, paneId, 'the pane to show it is working'),
        );

        const dialog = 'Do you want to proceed?\\n> 1. Yes\\n  2. No\\n';
        await typeInTerminal(
          page,
          `${agent} -c 'printf "\\033[2J\\033[H"; printf "${dialog}"; read; printf "\\033[2J\\033[H"; echo tool-running; read -t 120'`,
          { target: `[data-pane-id="${paneId}"] [role="log"]` },
        );
        await pressEnter(page);
        await waitForCondition(
          page,
          async () => (await headerMark(page, paneId)) === 'needs-input',
          // The screen is read every 1.5 s and tmux reports the option within
          // about a second: a mark that waits for the 15 s idle heartbeat is late.
          5000,
          () => seen(page, paneId, 'the dialog to mark the pane needs-input'),
        );

        // Answered on the keyboard, as the user does: the tool runs, and no
        // hook says so until it finishes.
        await pressEnter(page);
        await waitForCondition(
          page,
          async () => (await headerMark(page, paneId)) === 'working',
          // The screen is read every 1.5 s and tmux reports the option within
          // about a second: a mark that waits for the 15 s idle heartbeat is late.
          5000,
          () => seen(page, paneId, 'the answered dialog to mark the pane working again'),
        );
      } finally {
        tmuxRunAsOperator(`send-keys -t ${paneId} C-c`);
        tmuxyCli(['pane', 'state', 'clear', paneId]);
        remove();
      }
    }, 120000);
  },
);

/** The close confirmation as drawn: null unless it has a box on screen. */
async function closeQuestion(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="close-confirm"]');
    const box = dialog?.getBoundingClientRect();
    if (!dialog || !box || box.width < 100 || box.height < 40) return null;
    const inView = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight;
    return inView ? dialog.textContent : null;
  });
}

const paneIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane-layout-item[data-pane-id]')].map(
      (el) => el.dataset.paneId,
    ),
  );

describeE2E('Scenario: closing a pane that says it is working asks first', {}, (ctx) => {
  test('the close keys on a working pane ask → Escape keeps it → the ✕ asks again → Enter closes it → an idle pane closes at once', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);
    const busy = await page.evaluate(() => window.app?.view().activePaneId);

    tmuxyCli(['pane', 'state', 'working', busy]);
    await waitForCondition(
      page,
      async () => (await headerMark(page, busy)) === 'working',
      10000,
      () => seen(page, busy, 'the pane to show it is working'),
    );

    // The keyboard's close: held, with the question on screen.
    await killPaneKeyboard(page);
    await waitForCondition(
      page,
      async () => (await closeQuestion(page)) !== null,
      10000,
      'the close keys to ask before closing a working pane',
    );
    expect(await closeQuestion(page)).toMatch(/still working/);
    expect(await paneIds(page)).toContain(busy);

    // Escape keeps the pane, and it is still the working one.
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => (await closeQuestion(page)) === null,
      5000,
      'Escape to dismiss the question',
    );
    expect(await paneIds(page)).toHaveLength(2);
    expect(await headerMark(page, busy)).toBe('working');

    // The header's ✕ is the same close: it asks too, and Enter says yes.
    await page.click(`[data-pane-id="${busy}"] .pane-header-close`);
    await waitForCondition(
      page,
      async () => (await closeQuestion(page)) !== null,
      10000,
      'the ✕ to ask before closing a working pane',
    );
    await page.keyboard.press('Enter');
    await waitForPaneCount(page, 1);
    expect(await paneIds(page)).not.toContain(busy);
    expect(await closeQuestion(page)).toBeNull();

    // A pane that says nothing about itself closes at once, as it always did.
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);
    await killPaneKeyboard(page);
    await waitForPaneCount(page, 1);
    expect(await closeQuestion(page)).toBeNull();
  }, 120000);
});
