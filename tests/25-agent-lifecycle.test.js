/**
 * An agent's life in its pane: `tmuxy agent start` returns once it is ready,
 * `tmuxy agent revive` brings an exited one back into its conversation, and
 * the pane menu offers the same revive. Every agent here is a fake: a `cmd`
 * that declares its own state, or a `claude` first on a PATH set for the
 * suite's own server only (`helpers/fake-agent.js`).
 */

const fs = require('fs');
const { describeE2E, waitForShellPrompt, waitForCondition } = require('./helpers');
const { tmuxyCli, tmuxyCliAsync, TMUXY_CLI, agentHookEvent } = require('./helpers/cli');
const { fakeClaudeOnPath } = require('./helpers/fake-agent');

const ID = '0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34';

/** A shell spawned beside `caller`, as an agent's pane after the agent exits. */
function spawnShell(caller, command = ['bash', '--norc', '-i']) {
  return JSON.parse(
    tmuxyCli(['agent', 'spawn', '--json', '--agent', 'cmd', '--', ...command], {
      TMUX_PANE: caller,
    }),
  ).paneId;
}

function killPanes(panes) {
  for (const pane of panes.filter(Boolean)) {
    try {
      tmuxyCli(['pane', 'kill', pane]);
    } catch {
      // Already gone.
    }
  }
}

const recorded = (pane) =>
  tmuxyCli(['run', 'display-message', '-p', '-t', pane, '#{@tmuxy-agent-session}']).trim();

describeE2E("Scenario: an agent's life in its pane", {}, (ctx) => {
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

  test('agent revive resumes the recorded session in the pane, refuses live jobs, and never records a hostile id', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const fake = fakeClaudeOnPath(ctx.session);
    const panes = [];
    try {
      const child = spawnShell(caller);
      panes.push(child);
      // The hook, as an agent's runs it: the event's JSON on stdin.
      agentHookEvent('claude', 'SessionStart', { session_id: ID }, child);
      expect(recorded(child)).toBe(`claude:${ID}`);
      const owned = `${fake.scratch}/owned`;
      for (const hostile of [`${ID}; touch ${owned}`, `#(touch ${owned})`, `${ID}\nx`]) {
        agentHookEvent('claude', 'SessionStart', { session_id: hostile }, child);
        expect(recorded(child)).toBe(`claude:${ID}`);
      }

      expect(JSON.parse(tmuxyCli(['agent', 'revive', child, '--json']))).toMatchObject({
        ok: true,
        paneId: child,
        agent: 'claude',
        session: ID,
      });
      await waitForCondition(page, fake.args, 15000, 'the fake claude to be resumed');
      expect(fake.args()).toEqual(['--resume', ID]);
      expect(fs.existsSync(owned)).toBe(false);

      // While it runs, revive refuses: it is for a pane whose agent exited.
      const again = await tmuxyCliAsync(['agent', 'revive', child]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('revive would kill them');

      // A shell holding a stopped job is refused too: respawning it would
      // kill the job (a suspended editor, unsaved). The job is named as the
      // system lists it: `sleep`, or `bash` when stopped before it became sleep.
      const holder = spawnShell(caller, [
        'bash',
        '-c',
        'sleep 600 & kill -STOP $!; exec bash --norc -i',
      ]);
      panes.push(holder);
      agentHookEvent('claude', 'SessionStart', { session_id: ID }, holder);
      const stopped = await tmuxyCliAsync(['agent', 'revive', holder]);
      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toMatch(
        new RegExp(`${holder}'s shell still has jobs \\((sleep|bash)\\): revive would kill them`),
      );

      // A session that ends normally is taken off the pane.
      agentHookEvent('claude', 'SessionEnd', {}, holder);
      expect(recorded(holder)).toBe('');
    } finally {
      fake.restore();
      killPanes(panes);
    }
  }, 120000);

  test('the pane menu revives an agent session from its header', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const caller = await page.evaluate(() => window.app?.view().activePaneId);
    const fake = fakeClaudeOnPath(ctx.session);
    let child = null;
    try {
      child = spawnShell(caller);
      agentHookEvent('claude', 'SessionStart', { session_id: ID }, child);

      // The child's row header, collapsed in the stack, opens its pane menu,
      // which offers the item once revive's own check says it can.
      const header = page.locator(`[data-pane-tab="${child}"]`);
      await header.waitFor({ state: 'visible', timeout: 15000 });
      await header.click({ button: 'right' });
      const item = page.locator('[role="menuitem"]', { hasText: 'Revive Agent Session' });
      await item.waitFor({ state: 'visible', timeout: 10000 });
      await item.click();

      await waitForCondition(page, fake.args, 15000, 'the fake claude to be resumed from the menu');
      expect(fake.args()).toEqual(['--resume', ID]);
    } finally {
      fake.restore();
      killPanes([child]);
    }
  }, 120000);
});
