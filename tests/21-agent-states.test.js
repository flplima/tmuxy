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
  navigatePaneKeyboard,
  waitForPaneCount,
  waitForCondition,
} = require('./helpers');
const { tmuxyCli, tmuxyCliAsync, tmuxRunAsOperator } = require('./helpers/cli');

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

/**
 * An orchestrator waits on its agents' states, not their screens: a
 * collapsed row in a stack is one line tall, and its screen says nothing.
 * `tmuxy agent wait` reads `@tmuxy-pane-state`, which the agents' hooks set;
 * here the test sets it, as a hook would, with `tmuxy pane state`.
 */
describeE2E("Scenario: an orchestrator waits on its agents' states", {}, (ctx) => {
  test('agent wait ends when a labelled pane needs the user, --all waits for every one, and a timeout or an unknown label fails', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const first = await page.evaluate(() => window.app?.view().activePaneId);
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    const second = await page.evaluate(() => window.app?.view().activePaneId);
    const label = (pane, name) =>
      ctx.session.runAsOperator(`set-option -p -t ${pane} @tmuxy-label ${name}`);
    label(first, 'child-a');
    label(second, 'child-b');
    try {
      // Working when the wait begins. `--now` counts a pane already in a
      // wanted state, so the wait's first read and the writes below may
      // come in either order; that an already-settled pane does not end a
      // plain wait is the unit tests' (agents/wait_tests.rs).
      tmuxyCli(['pane', 'state', 'working', first]);
      tmuxyCli(['pane', 'state', 'working', second]);

      const any = tmuxyCliAsync([
        'agent',
        'wait',
        'child-a',
        'child-b',
        '--now',
        '--until',
        'needs-input',
        '--for',
        '30s',
        '--json',
      ]);
      tmuxyCli(['pane', 'state', 'needs-input', first]);
      const answered = await any;
      expect(answered.code).toBe(0);
      expect(JSON.parse(answered.stdout)).toEqual({
        ok: true,
        panes: [{ paneId: first, label: 'child-a', state: 'needs-input' }],
      });

      const all = tmuxyCliAsync([
        'agent',
        'wait',
        '--all',
        '--now',
        '--until',
        'done,error',
        first,
        second,
        '--for',
        '30s',
      ]);
      tmuxyCli(['pane', 'state', 'error', second]);
      tmuxyCli(['pane', 'state', 'unread', first]);
      const both = await all;
      expect(both.code).toBe(0);
      expect(both.stdout.trim().split('\n').sort()).toEqual(
        [`${first} child-a unread`, `${second} child-b error`].sort(),
      );

      const late = await tmuxyCliAsync([
        'agent',
        'wait',
        'child-b',
        '--until',
        'idle',
        '--for',
        '2s',
      ]);
      expect(late.code).toBe(1);
      expect(late.stderr).toContain('timed out');
      const nobody = await tmuxyCliAsync(['agent', 'wait', 'nobody', '--for', '2s']);
      expect(nobody.code).toBe(3);

      // A pane that goes away is not a pane that finished: exit 3, unless
      // the wait was for exactly that.
      const gone = tmuxyCliAsync(['agent', 'wait', 'child-b', '--for', '30s']);
      const goneAsked = tmuxyCliAsync([
        'agent',
        'wait',
        'child-b',
        '--until',
        'exited',
        '--for',
        '30s',
      ]);
      tmuxyCli(['pane', 'kill', second]);
      const ended = await gone;
      expect(ended.code).toBe(3);
      expect(ended.stderr).toContain(`${second} went away`);
      expect((await goneAsked).code).toBe(0);
    } finally {
      for (const pane of [first, second]) {
        try {
          tmuxyCli(['pane', 'state', 'clear', pane]);
        } catch {
          // The test closed it.
        }
      }
    }
  }, 120000);
});

/**
 * A program can say what it is doing in its own output, with the program
 * status protocol (OSC 7501): nothing is installed and no hook runs. The
 * "program" here is the shell's `printf`, which is all a build script or a
 * deploy tool needs to report.
 */
describeE2E(
  'Scenario: a program reports its status in its output and its pane shows it',
  {},
  (ctx) => {
    test('each reported state marks the pane, a new prompt ends a working one, and a result waits to be seen', async () => {
      const { page } = ctx;
      await ctx.setupPage();
      await waitForShellPrompt(page);
      const first = await page.evaluate(() => window.app?.view().activePaneId);
      // Two panes, so each has a header that shows its state.
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await waitForShellPrompt(page);
      const paneId = await page.evaluate(() => window.app?.view().activePaneId);
      expect(paneId).not.toBe(first);

      /** Print one OSC sequence from the pane in front, to its own terminal or `to` another. */
      const print = async (body, to = '') => {
        await typeInTerminal(page, `printf '\\033]${body}\\033\\\\'${to}`, {
          target: `[data-pane-id="${paneId}"] [role="log"]`,
        });
        await pressEnter(page);
      };
      const shows = (pane, mark, waitingFor) =>
        waitForCondition(
          page,
          async () => (await headerMark(page, pane)) === mark,
          10000,
          () => seen(page, pane, waitingFor),
        );

      try {
        await print('7501;state=working:app=make');
        await shows(paneId, 'working', 'the pane to show its program is working');

        // "Apply 3 to add?", as the protocol carries free text: base64.
        await print('7501;state=blocked:kind=permission:msg=QXBwbHkgMyB0byBhZGQ/');
        await shows(paneId, 'needs-input', 'a blocked program to mark the pane needs-input');
        // Pointing at the mark says what the program is waiting for.
        await page.hover(`[data-pane-tab="${paneId}"] .pane-state-mark`);
        await waitForCondition(
          page,
          () =>
            page.evaluate(() => {
              const tip = document.querySelector('[data-testid="tooltip"]');
              const box = tip?.getBoundingClientRect();
              return (
                !!box && box.width > 0 && tip.textContent === 'Needs your approval: Apply 3 to add?'
              );
            }),
          10000,
          async () =>
            `the mark's tooltip to say what the program asked; it says ${JSON.stringify(
              await page.evaluate(
                () => document.querySelector('[data-testid="tooltip"]')?.textContent ?? null,
              ),
            )}`,
        );

        // tmux holds the text beside the state, for whatever reads the pane
        // without having seen its output: another host, another session's.
        const heldText = () =>
          ctx.session.runCommand(`display-message -p -t ${paneId} '#{@tmuxy-pane-status}'`).trim();
        expect(heldText()).toBe('state=blocked:kind=permission:msg=QXBwbHkgMyB0byBhZGQ/');

        await print('7501;state=error');
        await shows(paneId, 'error', 'a failed program to mark the pane');

        await print('7501;state=clear');
        await shows(paneId, null, 'a cleared status to take the mark off');
        expect(heldText()).toBe('');

        // The shell's prompt mark ends a command that was still working.
        await print('7501;state=working');
        await shows(paneId, 'working', 'the pane to show its program is working again');
        await print('133;A');
        await shows(paneId, null, 'a new prompt to end the working state');

        // A result is for the pane the user is not looking at: reported on
        // the other pane's terminal, it waits there until that pane is in front.
        const tty = ctx.session.runCommand(`display-message -p -t ${first} '#{pane_tty}'`).trim();
        expect(tty).toMatch(/^\/dev\//);
        await print('7501;state=done', ` > ${tty}`);
        await shows(first, 'unread', 'a finished program to leave its result on the other pane');

        await navigatePaneKeyboard(page, 'next');
        await waitForCondition(
          page,
          async () => (await page.evaluate(() => window.app?.view().activePaneId)) === first,
          10000,
          'the first pane to come in front',
        );
        await shows(first, null, 'the result to be taken as seen once its pane is in front');
      } finally {
        tmuxyCli(['pane', 'state', 'clear', paneId]);
        tmuxyCli(['pane', 'state', 'clear', first]);
      }
    }, 120000);
  },
);
