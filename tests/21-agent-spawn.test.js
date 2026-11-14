/**
 * Sub-agents in panes: an orchestrator spawns an agent into its own tab
 * (`tmuxy agent spawn`), as an agent or a script would, through the CLI
 * against a real tmux, and the agent reports back with `tmuxy pane report`.
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
const { tmuxyCli, tmuxyCliAsync, TMUXY_CLI } = require('./helpers/cli');

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

  test("a spawned agent's report reaches its orchestrator, with agent wait too, and only the agent writes it", async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const said = "fixed 3 of 3: it's #{done}";
    let child = null;
    try {
      // The child writes its report from inside its own pane, as an agent
      // told to `tmuxy pane report` when done would.
      child = JSON.parse(
        tmuxyCli(
          [
            'agent',
            'spawn',
            '--json',
            '--agent',
            'cmd',
            '--label',
            'reporter',
            '--',
            'bash',
            '-c',
          ].concat([`"${TMUXY_CLI}" pane report "$1"; exec sleep 600`, '_', said]),
          { TMUX_PANE: caller },
        ),
      ).paneId;
      const report = await waitForCondition(
        page,
        () => {
          try {
            return tmuxyCli(['pane', 'report', '-t', 'reporter']);
          } catch {
            return null;
          }
        },
        20000,
        'the child to write its report',
      );
      expect(report.trim()).toBe(said);
      const read = JSON.parse(tmuxyCli(['pane', 'report', '-t', 'reporter', '--json']));
      expect(read).toMatchObject({ ok: true, paneId: child, report: said });
      expect(typeof read.at).toBe('number');

      // `agent wait --json` hands the report over with the state.
      tmuxyCli(['pane', 'state', 'idle', child]);
      const waited = JSON.parse(
        tmuxyCli(['agent', 'wait', 'reporter', '--now', '--json', '--for', '10s']),
      );
      expect(waited.panes[0]).toMatchObject({ paneId: child, state: 'idle', report: said });

      // A report is its own pane's: a process outside it cannot write one
      // by naming the pane, and -t only reads.
      const forged = await tmuxyCliAsync(['pane', 'report', 'forged'], { TMUX_PANE: child });
      expect(forged.code).toBe(1);
      const written = await tmuxyCliAsync(['pane', 'report', '-t', 'reporter', 'forged']);
      expect(written.code).toBe(2);
      expect(tmuxyCli(['pane', 'report', '-t', 'reporter']).trim()).toBe(said);

      const none = await tmuxyCliAsync(['pane', 'report', '-t', caller]);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain('has no report');
    } finally {
      if (child) {
        try {
          tmuxyCli(['pane', 'kill', child]);
        } catch {
          // Already gone.
        }
      }
    }
  }, 120000);
});
