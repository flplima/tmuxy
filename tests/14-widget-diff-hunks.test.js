/**
 * A diff's hunk actions through the real CLI, server and git, on a
 * throwaway checkout: a hunk staged and unstaged alone; one reverted only
 * behind a confirm that shows it, then put back with Undo; and a revert
 * refused when the file changed after the diff was drawn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeE2E, waitForShellPrompt, waitForCondition } = require('./helpers');
const { gitRepo } = require('./helpers/git-repo');
const { openDiff, waitForDiff, waitForNotice } = require('./helpers/diff-widget');

/** Twenty numbered lines committed, then lines 2 and 18 changed: two hunks. */
function twoHunks(dir) {
  const { git } = gitRepo(dir);
  const lines = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`);
  fs.writeFileSync(path.join(dir, 'list.txt'), `${lines.join('\n')}\n`);
  git('add', '-A');
  git('commit', '-qm', 'list');
  lines[1] = 'line 2, changed';
  lines[17] = 'line 18, changed';
  fs.writeFileSync(path.join(dir, 'list.txt'), `${lines.join('\n')}\n`);
}

/** The added lines the diff shows, in order. */
const added = (shown) => shown.lines.filter((l) => l.kind === 'added').map((l) => l.text);

describeE2E(
  'Scenario: a diff’s hunks are staged, unstaged and reverted one at a time',
  {},
  (ctx) => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-diff-hunks-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('stage and unstage one hunk; revert one behind a confirm and undo it; refuse a revert of a file changed since', async () => {
      const { page } = ctx;
      await ctx.setupPage();
      await waitForShellPrompt(page);
      twoHunks(dir);
      const file = path.join(dir, 'list.txt');
      const onDisk = () => fs.readFileSync(file, 'utf8');
      await openDiff(page, dir);
      await waitForDiff(page, 'the two hunks', (s) => added(s).length === 2);

      // 1. Stage the first hunk alone, then unstage it.
      await page.getByRole('button', { name: 'Stage hunk 1 of list.txt' }).click();
      await waitForNotice(page, 'Staged a hunk of list.txt');
      await waitForDiff(
        page,
        'one hunk left unstaged',
        (s) => added(s).join() === 'line 18, changed',
      );
      await page.getByRole('tab', { name: 'Staged', exact: true }).click();
      await waitForDiff(
        page,
        'the staged hunk',
        (s) => s.scope === 'staged' && added(s).join() === 'line 2, changed',
      );
      await page.getByRole('button', { name: 'Unstage hunk 1 of list.txt' }).click();
      await waitForDiff(
        page,
        'nothing staged',
        (s) => s.scope === 'staged' && s.files.length === 0,
      );
      await page.getByRole('tab', { name: 'Unstaged', exact: true }).click();
      await waitForDiff(
        page,
        'both hunks unstaged',
        (s) => s.scope === 'unstaged' && added(s).length === 2,
      );

      // 2. Revert the second: a confirm shows it first; then it is gone from
      //    the file, and Undo puts it back.
      const before = onDisk();
      await page.getByRole('button', { name: 'Revert… hunk 2 of list.txt' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Revert this hunk?' });
      expect(await confirm.textContent()).toContain('+line 18, changed');
      expect((await confirm.boundingBox()).height).toBeGreaterThan(20);
      expect(onDisk()).toBe(before);
      await page.getByRole('button', { name: 'Revert this hunk' }).click();
      await waitForNotice(page, 'Reverted a hunk of list.txt');
      expect(onDisk()).toContain('\nline 18\n');
      expect(onDisk()).toContain('line 2, changed');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await waitForNotice(page, 'Put back list.txt as it was');
      expect(onDisk()).toBe(before);
      await waitForDiff(page, 'both hunks back', (s) => added(s).length === 2);

      // 3. The diff is drawn and the revert asked; then the file changes
      //    before the yes. Nothing is done.
      await page.getByRole('button', { name: 'Revert… hunk 1 of list.txt' }).click();
      const edited = onDisk().replace('line 10\n', 'line 10, edited after the diff was drawn\n');
      fs.writeFileSync(file, edited);
      await page.getByRole('button', { name: 'Revert this hunk' }).click();
      await waitForNotice(page, 'list.txt changed since the diff was drawn: nothing was done');
      expect(onDisk()).toBe(edited);
      await waitForCondition(
        page,
        async () => (await page.locator('[data-diff-undo]').count()) === 0,
        5000,
        'no undo offered for a revert that was not done',
      );
    }, 120000);
  },
);
