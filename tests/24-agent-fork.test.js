/**
 * `tmuxy agent fork`: a pane's conversation carried on in a new worktree
 * and tab.
 *
 * The repository is a throwaway one in the temp dir, made before the test
 * and removed after; the agent is a script that says what it was given,
 * never a real one.
 */

const fs = require('fs');
const path = require('path');
const { describeE2E, waitForShellPrompt, waitForCondition } = require('./helpers');
const { git, throwawayRepo } = require('./helpers/git-repo');
const { tmuxyCli, agentHookEvent } = require('./helpers/cli');

describeE2E('Scenario: a conversation forked into a worktree of its own', {}, (ctx) => {
  /**
   * The session is recorded as an agent's hook records it; the
   * "claude" is a fake, first on a PATH set for this test server only, that
   * says what it was given: no real agent runs.
   */
  test('agent fork opens the recorded conversation as a fork in a new worktree and tab', async () => {
    const { page } = ctx;
    const where = throwawayRepo('app');
    const id = '0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34';
    const fake = path.join(where.root, 'bin');
    const marker = path.join(where.root, 'forked-with');
    fs.mkdirSync(fake);
    fs.writeFileSync(
      path.join(fake, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\necho "FAKE CLAUDE in $(pwd)"\nexec sleep 600\n`,
    );
    fs.chmodSync(path.join(fake, 'claude'), 0o755);
    let pathBefore = '';
    let original = null;
    try {
      await ctx.setupPage();
      await waitForShellPrompt(page);
      pathBefore = tmuxyCli(['run', 'show-environment', '-g', 'PATH'])
        .trim()
        .replace(/^PATH=/, '');
      const caller = await page.evaluate(() => window.app?.view().activePaneId);
      const firstTab = await page.evaluate(() => window.app?.view().activeTabId);
      expect(pathBefore).toContain('/');
      ctx.session.runAsOperator(`set-environment -g PATH '${fake}:${pathBefore}'`);
      original = JSON.parse(
        tmuxyCli(
          [
            'agent',
            'spawn',
            '--json',
            '--agent',
            'cmd',
            '--label',
            'talk',
            '--cwd',
            where.repo,
          ].concat(['--', 'bash', '--norc', '-i']),
          { TMUX_PANE: caller },
        ),
      ).paneId;
      agentHookEvent('claude', 'SessionStart', { session_id: id }, original);
      // Work the conversation is about, not committed yet, and a scratch file.
      fs.writeFileSync(path.join(where.repo, 'README'), 'hello, being edited\n');
      fs.writeFileSync(path.join(where.repo, 'notes.txt'), 'scratch\n');

      const answer = JSON.parse(
        tmuxyCli(['agent', 'fork', 'talk', '--json'], { TMUX_PANE: caller }),
      );
      const worktree = path.join(where.root, 'app-fork-0b5c2f4e');
      expect(answer).toMatchObject({
        ok: true,
        branch: 'fork-0b5c2f4e',
        session: id,
        carried: 1,
        untracked: 0,
      });
      expect(fs.realpathSync(answer.path)).toBe(worktree);

      // The fork runs in the new tab, in the worktree, with the fork flags.
      await waitForCondition(
        page,
        () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8'),
        20000,
        'the fake claude to be started',
      );
      expect(fs.readFileSync(marker, 'utf-8').trim().split('\n')).toEqual([
        '--resume',
        id,
        '--fork-session',
      ]);
      await waitForCondition(
        page,
        () =>
          page.evaluate(
            ([first, text]) => {
              const view = window.app?.view();
              const log = document.querySelector('.pane-active [role="log"]');
              const box = log?.getBoundingClientRect();
              return (
                view?.activeTabId !== first &&
                !!box &&
                box.width > 0 &&
                log.textContent.includes(text)
              );
            },
            [firstTab, `FAKE CLAUDE in ${worktree}`],
          ),
        20000,
        'the new tab to show the fork running in the worktree',
      );
      expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fork-0b5c2f4e');
      expect(git(where.repo, 'worktree', 'list')).toContain(worktree);
      // The uncommitted edit came along; the untracked file did not, unasked.
      expect(fs.readFileSync(path.join(worktree, 'README'), 'utf-8')).toBe('hello, being edited\n');
      expect(fs.existsSync(path.join(worktree, 'notes.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(where.repo, 'README'), 'utf-8')).toBe(
        'hello, being edited\n',
      );

      // A second fork of the same conversation needs a branch of its own.
      expect(() => tmuxyCli(['agent', 'fork', 'talk'], { TMUX_PANE: caller })).toThrow(/--branch/);

      // A pane with no recorded session has nothing to fork.
      expect(() => tmuxyCli(['agent', 'fork', caller], { TMUX_PANE: caller })).toThrow(
        /no agent session to fork/,
      );
    } finally {
      if (pathBefore) ctx.session.runAsOperator(`set-environment -g PATH '${pathBefore}'`);
      if (original) {
        try {
          tmuxyCli(['pane', 'kill', original]);
        } catch {
          // Already gone.
        }
      }
      where.remove();
    }
  }, 120000);
});
