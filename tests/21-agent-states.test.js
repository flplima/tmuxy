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
} = require('./helpers');
const { tmuxyCli, tmuxyCliAsync, tmuxRunAsOperator, TMUXY_CLI } = require('./helpers/cli');

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
 * `tmuxy agent spawn` puts an agent in the caller's own tab with its task.
 * The "agent" is `--agent cmd`: a shell that prints its task and waits, so
 * no real agent runs; the adapters' command lines are the unit tests'
 * (agents/spawn_tests.rs).
 */
describeE2E('Scenario: an orchestrator spawns an agent into its own tab', {}, (ctx) => {
  test("agent spawn adds a tagged row to the caller's tab, keeps the focus, hands over the task, refuses a taken label and keeps #() in a label or path as text", async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const asCaller = { TMUX_PANE: caller };
    let child = null;
    let second = null;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-spawn-'));
    try {
      const out = tmuxyCli(
        [
          'agent',
          'spawn',
          '--json',
          '--agent',
          'cmd',
          '--label',
          'child-x',
          '--',
          'bash',
          '-c',
          'echo "task: $1"; exec sleep 600',
          '_',
          "it's #{a} task",
        ],
        asCaller,
      );
      const answer = JSON.parse(out);
      expect(answer).toMatchObject({ ok: true, label: 'child-x', agent: 'bash' });
      child = answer.paneId;
      await waitForPaneCount(page, 2);

      const read = (format) =>
        tmuxyCli(['run', 'display-message', '-p', '-t', child, format]).trim();
      expect(read('#{window_id}')).toBe(
        tmuxyCli(['run', 'display-message', '-p', '-t', caller, '#{window_id}']).trim(),
      );
      expect(read('#{@tmuxy-collapsible}')).toBe('1');
      expect(read('#{@tmuxy-spawned-by} #{@tmuxy-agent} #{@tmuxy-label}')).toBe(
        `${caller} bash child-x`,
      );

      // The focus stays with the caller; the new row shows as a header.
      expect(await page.evaluate(() => window.app?.view().activePaneId)).toBe(caller);
      await waitForCondition(
        page,
        () =>
          page.evaluate((id) => {
            const header = document.querySelector(`[data-pane-tab="${id}"]`);
            const box = header?.getBoundingClientRect();
            return (
              !!box && box.width > 0 && box.height > 0 && header.textContent.includes('child-x')
            );
          }, child),
        15000,
        "the spawned row's header, named child-x, to be drawn",
      );

      // The task reached the agent as one argument, quotes and #{} intact.
      const screen = await waitForCondition(
        page,
        () => {
          // A collapsed row is one line tall: the line is in its history.
          const text = tmuxyCli(['run', 'capture-pane', '-p', '-S', '-', '-t', child]);
          return text.includes('task: ') && text;
        },
        15000,
        'the agent to print its task',
      );
      expect(screen).toContain("task: it's #{a} task");

      const taken = await tmuxyCliAsync(
        ['agent', 'spawn', '--agent', 'cmd', '--label', 'child-x', '--', 'true'],
        asCaller,
      );
      expect(taken.code).not.toBe(0);
      expect(taken.stderr).toContain('already labelled child-x');

      // A label or a directory holding `#(…)` reaches tmux as text: tmux
      // expands formats in a pane's title and start directory, where an
      // unescaped one would run the command as the server. Ending in `;`,
      // each stays one argument, rather than ending tmux's command there.
      const marker = path.join(scratch, 'ran');
      const hostile = `#(touch ${marker});`;
      const cwd = path.join(scratch, hostile);
      fs.mkdirSync(cwd, { recursive: true });
      second = JSON.parse(
        tmuxyCli(
          [
            'agent',
            'spawn',
            '--json',
            '--agent',
            'cmd',
            '--place',
            'split',
            '--label',
            hostile,
          ].concat(['--cwd', cwd, '--', 'sleep', '600']),
          asCaller,
        ),
      ).paneId;
      const readSecond = (format) =>
        tmuxyCli(['run', 'display-message', '-p', '-t', second, format]).trim();
      await waitForCondition(
        page,
        () => readSecond('#{pane_current_path}') === cwd,
        15000,
        () => `the second agent to start in ${cwd}, not ${readSecond('#{pane_current_path}')}`,
      );
      expect(readSecond('#{pane_title}')).toBe(hostile);
      expect(readSecond('#{@tmuxy-label}')).toBe(hostile);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      for (const pane of [child, second].filter(Boolean)) {
        try {
          tmuxyCli(['pane', 'kill', pane]);
        } catch {
          // Already gone.
        }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);

  test('agent start returns once the agent has a state, fails when it exits first, and gives up on --for', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const asCaller = { TMUX_PANE: caller };
    const started = [];
    try {
      // The "agent" declares its state a second in, as a hook does when a
      // session starts.
      const before = Date.now();
      const ready = await tmuxyCliAsync(
        ['agent', 'start', 'starter', '--json', '--agent', 'cmd', '--', 'bash', '-c'].concat([
          `sleep 1; "${TMUXY_CLI}" pane state idle; exec sleep 600`,
        ]),
        asCaller,
      );
      expect(ready.code).toBe(0);
      const answer = JSON.parse(ready.stdout);
      started.push(answer.paneId);
      expect(answer).toMatchObject({ ok: true, label: 'starter', agent: 'bash', state: 'idle' });
      expect(Date.now() - before).toBeGreaterThanOrEqual(1000);

      // It exits a second in, after spawn has tagged its pane: tmux then
      // answers a read of the gone pane with another pane's, which must not
      // pass for this one still starting.
      const exited = await tmuxyCliAsync(
        ['agent', 'start', 'quitter', '--for', '20s', '--agent', 'cmd', '--', 'sleep', '1'],
        asCaller,
      );
      expect(exited.code).toBe(1);
      expect(exited.stderr).toContain('quitter exited before it was ready');

      const slow = await tmuxyCliAsync(
        ['agent', 'start', 'sleeper', '--for', '2s', '--agent', 'cmd', '--', 'sleep', '600'],
        asCaller,
      );
      expect(slow.code).toBe(1);
      expect(slow.stderr).toContain('sleeper was not ready within 2s; it is still running in %');
      const still = slow.stderr.match(/still running in (%\d+)/)[1];
      started.push(still);
      expect(
        tmuxyCli(['run', 'display-message', '-p', '-t', still, '#{@tmuxy-label}']).trim(),
      ).toBe('sleeper');

      const twice = await tmuxyCliAsync(
        ['agent', 'start', 'x', '--label', 'y', '--agent', 'cmd', '--', 'true'],
        asCaller,
      );
      expect(twice.code).toBe(2);
    } finally {
      for (const pane of started) {
        try {
          tmuxyCli(['pane', 'kill', pane]);
        } catch {
          // Already gone.
        }
      }
    }
  }, 120000);
});
