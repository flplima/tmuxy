/**
 * `tmuxy worktree new`: one command makes a worktree for a task, a tab in it
 * named after the branch, and starts the agent there with the task.
 *
 * The repository is a throwaway one in the temp dir, made before the test
 * and removed after; the agent is a script that says what it was given,
 * never a real one.
 */

const fs = require('fs');
const path = require('path');
const {
  describeE2E,
  focusPage,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  TMUXY_CLI,
} = require('./helpers');
const { git, throwawayRepo } = require('./helpers/git-repo');

/**
 * A repository with one commit, and an "agent" that reads its arguments the
 * way an agent's own parser does: a word after `--` is the task, a word
 * starting with `-` before it is an option.
 */
function scene() {
  const where = throwawayRepo('app');
  const agent = path.join(where.root, 'fake-agent');
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --) shift; echo "FAKE AGENT in $(pwd) was asked: $*" ;;',
      '  -*) echo "FAKE AGENT took an option: $1" ;;',
      '  *) echo "FAKE AGENT in $(pwd) was asked: $*" ;;',
      'esac',
      'exec sleep 600',
      '',
    ].join('\n'),
  );
  fs.chmodSync(agent, 0o755);
  return { ...where, agent };
}

/** The pane in front's text, once it holds `text`. */
async function waitForActiveText(page, text, what) {
  let seen = '';
  await waitForCondition(
    page,
    async () => {
      seen = await page.evaluate(() => {
        const log = document.querySelector('.pane-active [role="log"]');
        const box = log?.getBoundingClientRect();
        return box && box.width > 0 ? log.textContent : '';
      });
      return seen.includes(text);
    },
    20000,
    () => `${what}; the pane in front shows ${JSON.stringify(seen.trim().slice(-300))}`,
  );
  return seen;
}

describeE2E('Scenario: a task in a worktree of its own', {}, (ctx) => {
  test('one command makes the worktree, a tab named after the branch, and the agent running with the task', async () => {
    const { page } = ctx;
    const where = scene();
    try {
      await ctx.setupPage();
      await focusPage(page);
      await waitForShellPrompt(page);
      const firstTab = await page.evaluate(() => window.app?.view().activeTabId);

      await typeInTerminal(
        page,
        `cd ${where.repo} && ${TMUXY_CLI} worktree new --agent ${where.agent} -- Fix the login redirect`,
      );
      await pressEnter(page);

      // The new tab is in front, named after the branch, its terminal on screen.
      const worktree = path.join(where.root, 'app-fix-the-login-redirect');
      const said = `FAKE AGENT in ${worktree} was asked: Fix the login redirect`;
      let shown = null;
      await waitForCondition(
        page,
        async () => {
          shown = await page.evaluate(() => {
            const view = window.app?.view();
            const tab = document.querySelector(`.tab-name[data-window-id="${view?.activeTabId}"]`);
            const log = document.querySelector('.pane-active [role="log"]');
            const box = log?.getBoundingClientRect();
            return {
              tabId: view?.activeTabId,
              tabName: tab && tab.getBoundingClientRect().width > 0 ? tab.textContent.trim() : null,
              text: box && box.width > 0 ? log.textContent : '',
            };
          });
          return shown.tabId !== firstTab && shown.text.includes(said);
        },
        20000,
        async () => `the new tab to show the agent with its task; saw ${JSON.stringify(shown)}`,
      );
      expect(shown.tabName).toContain('fix-the-login-redirect');

      // git agrees: the worktree is there, on its own branch.
      expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix-the-login-redirect');
      expect(git(where.repo, 'worktree', 'list')).toContain(worktree);
      const pane = ctx.session
        .runCommand(`display-message -p -t ${shown.tabId} '#{pane_current_path}'`)
        .trim();
      expect(fs.realpathSync(pane)).toBe(worktree);
    } finally {
      where.remove();
    }
  }, 120000);

  // A task is text for the agent even when it reads like one of its options.
  test('a task that starts with a dash reaches the agent as the task, not as an option', async () => {
    const { page } = ctx;
    const where = scene();
    try {
      await ctx.setupPage();
      await focusPage(page);
      await waitForShellPrompt(page);
      await typeInTerminal(
        page,
        `cd ${where.repo} && ${TMUXY_CLI} worktree new --branch resume-check --agent ${where.agent} -- --resume`,
      );
      await pressEnter(page);
      const shown = await waitForActiveText(
        page,
        'was asked: --resume',
        'the agent to be given --resume as its task',
      );
      expect(shown).not.toContain('took an option');
    } finally {
      where.remove();
    }
  }, 120000);
});
