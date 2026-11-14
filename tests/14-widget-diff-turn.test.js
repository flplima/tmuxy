/**
 * The diff's "Last turn" scope: what changed in a checkout while a pane
 * beside the diff was in a turn (`@tmuxy-pane-state` working, through any
 * question it asked), through the real CLI, server, watcher and git, on a
 * throwaway checkout. The user's own edits from before and after the turn
 * stay out, and the repository is not written to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TMUXY_CLI,
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
} = require('./helpers');
const { tmuxyCli } = require('./helpers/cli');
const { shownDiff, checkout, waitForDiff } = require('./helpers/diff-widget');

/** The error the widget shows over its files, if any. */
function shownError(page) {
  return page.evaluate(() => {
    const { activePaneId } = window.app.view();
    const pane = document.querySelector(`.pane-wrapper[data-pane-id="${activePaneId}"]`);
    return pane?.querySelector('.diff-widget .diff-error')?.textContent ?? null;
  });
}

/** The files the turn says it left out, as listed on screen. */
function leftOut(page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-diff-names="Left out of this turn, not copied"] .diff-untracked-name',
      ),
    ].map((n) => n.textContent),
  );
}

describeE2E('Scenario: the diff shows an agent’s last turn', {}, (ctx) => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-diff-turn-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a turn holds what changed while the pane beside worked, and nothing from before or after', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    // Before any turn: the user's own unstaged edit (app.txt) and file (loose.txt).
    checkout(dir);
    const index = path.join(dir, '.git', 'index');
    const indexBefore = fs.statSync(index).mtimeMs;

    // The working pane in the checkout, the diff beside it.
    const agentPane = await page.evaluate(() => window.app.view().activePaneId);
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 2);
    await waitForShellPrompt(page);
    ctx.session.runAsOperator(`send-keys -t ${agentPane} -l 'cd ${dir}'`);
    ctx.session.runAsOperator(`send-keys -t ${agentPane} Enter`);
    await typeInTerminal(page, `cd ${dir} && clear && ${TMUXY_CLI} widget diff`);
    await pressEnter(page);
    await waitForDiff(page, 'the unstaged changes', (s) => s.files.includes('app.txt'));

    try {
      // 1. No turn seen yet: the scope says so.
      await page.getByRole('tab', { name: 'Last turn', exact: true }).click();
      let error = null;
      await waitForDiff(page, 'the scope to say no turn was seen', async () => {
        error = await shownError(page);
        return (error ?? '').includes('no agent turn seen here yet');
      });

      // 2. A turn starts: nothing in it yet.
      tmuxyCli(['pane', 'state', 'working', agentPane]);
      let shown = await waitForDiff(
        ctx.page,
        'the turn so far, empty',
        (s) => s.compared === `${agentPane}'s turn so far`,
      );
      expect(shown.files).toEqual([]);

      // 3. What changes in it shows while it goes on, a new file too; a
      //    question on the way is part of the same turn.
      fs.writeFileSync(path.join(dir, 'committed.txt'), 'changed in the turn\n');
      fs.writeFileSync(path.join(dir, 'agent.txt'), 'made in the turn\n');
      // Never copied: a secret's file and a large one.
      fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=not-for-the-store\n');
      fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
      tmuxyCli(['pane', 'state', 'needs-input', agentPane]);
      shown = await waitForDiff(page, 'the turn’s two files', (s) => s.files.length === 2);
      expect([...shown.files].sort()).toEqual(['agent.txt', 'committed.txt']);
      expect(shown.compared).toBe(`${agentPane}'s turn so far`);
      tmuxyCli(['pane', 'state', 'working', agentPane]);

      // 4. The turn ends; the user edits on. The turn keeps what it had.
      tmuxyCli(['pane', 'state', 'idle', agentPane]);
      await waitForDiff(page, 'the turn to end', (s) => s.compared === `${agentPane}'s last turn`);
      fs.writeFileSync(path.join(dir, 'after.txt'), 'after the turn\n');
      await page.getByRole('tab', { name: 'Unstaged', exact: true }).click();
      await waitForDiff(page, 'the edit after the turn', (s) => s.untracked.includes('after.txt'));
      await page.getByRole('tab', { name: 'Last turn', exact: true }).click();
      shown = await waitForDiff(
        page,
        'the last turn again',
        (s) => s.scope === 'turn' && s.compared === `${agentPane}'s last turn`,
      );
      expect([...shown.files].sort()).toEqual(['agent.txt', 'committed.txt']);
      expect(shown.lines.some((line) => line.text === 'made in the turn')).toBe(true);
      expect(await leftOut(page)).toEqual(['.env (named like a secret)', 'data.bin (over 1 MB)']);
      expect((await shownDiff(page)).widget.height).toBeGreaterThan(50);

      // Nothing was written into the repository: its index is untouched.
      expect(fs.statSync(index).mtimeMs).toBe(indexBefore);
    } finally {
      tmuxyCli(['pane', 'state', 'clear', agentPane]);
    }
  }, 120000);
});
