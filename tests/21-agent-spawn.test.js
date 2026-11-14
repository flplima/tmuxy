/**
 * Sub-agents in panes: an orchestrator spawns an agent into its own tab
 * (`tmuxy agent spawn`), as an agent or a script would, through the CLI
 * against a real tmux; `tmuxy agent start` waits for it to be ready, and
 * `tmuxy agent revive` resumes an agent's recorded session in its pane.
 * Waiting on their states is in 21-agent-states.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeE2E,
  waitForShellPrompt,
  waitForPaneCount,
  waitForCondition,
} = require('./helpers');
const { tmuxyCli, tmuxyCliAsync, TMUXY_CLI, agentHookEvent } = require('./helpers/cli');

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

  /**
   * A hook records the session on the pane; `agent revive` resumes it in
   * place. The "claude" is a fake on a PATH set for this test server only,
   * and the test proves the fake ran: no real agent is started or resumed.
   */
  test('agent revive resumes the recorded session in the pane, and a hostile session id is never recorded', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const id = '0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34';
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-revive-'));
    const marker = path.join(scratch, 'resumed-with');
    const fake = path.join(scratch, 'bin');
    fs.mkdirSync(fake);
    fs.writeFileSync(
      path.join(fake, 'claude'),
      `#!/bin/bash\nprintf '%s\\n' "$@" > '${marker}'\necho "fake claude resumed $2"\nexec -a claude sleep 600\n`,
    );
    fs.chmodSync(path.join(fake, 'claude'), 0o755);
    const pathBefore = tmuxyCli(['run', 'show-environment', '-g', 'PATH'])
      .trim()
      .replace(/^PATH=/, '');
    let child = null;
    const extra = [];
    try {
      expect(pathBefore).toContain('/');
      ctx.session.runAsOperator(`set-environment -g PATH '${fake}:${pathBefore}'`);
      child = JSON.parse(
        tmuxyCli(['agent', 'spawn', '--json', '--agent', 'cmd', '--', 'bash', '--norc', '-i'], {
          TMUX_PANE: caller,
        }),
      ).paneId;
      // The hook, as an agent's runs it: the event's JSON on stdin.
      const hook = (sessionId) =>
        agentHookEvent('claude', 'SessionStart', { session_id: sessionId }, child);
      const recorded = () =>
        tmuxyCli(['run', 'display-message', '-p', '-t', child, '#{@tmuxy-agent-session}']).trim();
      hook(id);
      expect(recorded()).toBe(`claude:${id}`);
      for (const hostile of [
        `${id}; touch ${scratch}/owned`,
        `#(touch ${scratch}/owned)`,
        `${id}\nx`,
      ]) {
        hook(hostile);
        expect(recorded()).toBe(`claude:${id}`);
      }
      expect(fs.existsSync(path.join(scratch, 'owned'))).toBe(false);

      expect(JSON.parse(tmuxyCli(['agent', 'revive', child, '--json']))).toMatchObject({
        ok: true,
        paneId: child,
        agent: 'claude',
        session: id,
      });
      await waitForCondition(
        page,
        () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8'),
        15000,
        'the fake claude to be resumed',
      );
      expect(fs.readFileSync(marker, 'utf-8').trim().split('\n')).toEqual(['--resume', id]);

      // While it runs, revive refuses: it is for a pane whose agent exited.
      const again = await tmuxyCliAsync(['agent', 'revive', child]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('revive would kill them');

      // A shell holding a stopped job is refused too: respawning it would
      // kill the job (a suspended editor, unsaved).
      const holder = JSON.parse(
        tmuxyCli(
          ['agent', 'spawn', '--json', '--agent', 'cmd', '--', 'bash', '-c'].concat([
            'sleep 600 & kill -STOP $!; exec bash --norc -i',
          ]),
          { TMUX_PANE: caller },
        ),
      ).paneId;
      extra.push(holder);
      agentHookEvent('claude', 'SessionStart', { session_id: id }, holder);
      const stopped = await tmuxyCliAsync(['agent', 'revive', holder]);
      expect(stopped.code).toBe(1);
      // The job is named as the system lists it: `sleep`, or `bash` when it
      // was stopped before it became sleep.
      expect(stopped.stderr).toMatch(
        new RegExp(`${holder}'s shell still has jobs \\((sleep|bash)\\): revive would kill them`),
      );

      // A session that ends normally is taken off the pane.
      agentHookEvent('claude', 'SessionEnd', {}, holder);
      expect(
        tmuxyCli(['run', 'display-message', '-p', '-t', holder, '#{@tmuxy-agent-session}']).trim(),
      ).toBe('');
    } finally {
      if (pathBefore) ctx.session.runAsOperator(`set-environment -g PATH '${pathBefore}'`);
      for (const pane of [child, ...extra].filter(Boolean)) {
        try {
          tmuxyCli(['pane', 'kill', pane]);
        } catch {
          // Already gone.
        }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
