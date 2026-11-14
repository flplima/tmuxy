/**
 * Input & Interaction E2E Tests (the shell's prompts in the scrollback)
 *
 * A shell with OSC 133 integration marks each prompt and each command's
 * output, and tmux keeps the marks on their lines. The pane menu goes from
 * prompt to prompt and copies what the newest command printed, the scrollback
 * draws a mark beside each prompt, and in copy mode `[` and `]` move the
 * cursor between them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeE2E,
  focusPage,
  runCommand,
  waitForShellPrompt,
  getCopyModeState,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
  clickMenuItem,
} = require('./helpers');

/**
 * A bash whose prompt is `mark$ ` and carries the three marks a shell
 * integration sends: `D` with the exit status before each prompt, `A` at
 * the prompt, `C` before a command's output.
 */
function markedShell() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-prompts-'));
  const rc = path.join(dir, 'rc');
  fs.writeFileSync(
    rc,
    [
      String.raw`PS0='\e]133;C\e\\'`,
      String.raw`PROMPT_COMMAND='printf "\033]133;D;%s\033\\\\" "$?"'`,
      String.raw`PS1='\[\e]133;A\e\\\]mark$ '`,
      '',
    ].join('\n'),
  );
  return {
    command: `bash --noprofile --rcfile ${rc}`,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** tmux 3.4 is the first that keeps prompt marks: `3.6`, `3.2a`, `next-3.9`. */
function tmuxKeepsPromptMarks(ctx) {
  const version = ctx.session.runCommand("display-message -p '#{version}'");
  const [, major, minor] = version.match(/(\d+)\.(\d+)/) ?? [];
  return Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 4);
}

/**
 * The scrollback row `row` of the active pane as it is drawn: its text, where
 * it is, where the view's visible area starts, and the prompt mark on it.
 */
function drawnRow(page, row) {
  return page.evaluate((wanted) => {
    const pre = document.querySelector('.pane-active [data-testid="scrollback-terminal"]');
    const line = pre?.querySelector(`.terminal-line[data-row="${wanted}"]`);
    if (!pre || !line) return null;
    let scroller = pre.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
    };
    return {
      text: line.textContent,
      line: box(line),
      view: box(scroller),
      mark: box(
        pre.parentElement.querySelector(`[data-testid="prompt-mark"][data-row="${wanted}"]`),
      ),
      cursor: box(pre.parentElement.querySelector('.terminal-cursor-copy')),
    };
  }, row);
}

/** A notice the snackbar is showing. */
const noticeShown = (page, text) =>
  page.evaluate(
    (wanted) =>
      [...document.querySelectorAll('[data-testid="snackbar-item"]')].some(
        (el) => el.getBoundingClientRect().width > 0 && el.textContent.includes(wanted),
      ),
    text,
  );

const notices = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="snackbar-item"]')].map((el) => el.textContent),
  );

/** The marked shell, with a long command and a short one behind its prompt. */
async function openMarkedShell(ctx, shell) {
  const { page } = ctx;
  await ctx.setupPage();
  await focusPage(page);
  await waitForShellPrompt(page);
  await runCommand(page, shell.command, 'mark$');
  // Far more rows than the pane is tall: the first prompt is deep in the history.
  await runCommand(page, 'seq 1 200', '200');
  await runCommand(page, "printf 'alpha\\nbeta\\n'", 'beta');
  await waitForShellPrompt(page);
}

describeE2E("Scenario: the shell's prompts in the scrollback", {}, (ctx) => {
  test('the menu goes to the previous prompt and back, the prompt is marked, and Copy Last Output takes what the newest command printed', async () => {
    const { page } = ctx;
    const shell = markedShell();
    try {
      await openMarkedShell(ctx, shell);

      if (!tmuxKeepsPromptMarks(ctx)) {
        // An older tmux keeps no marks: the menu says so and opens nothing.
        await clickMenuItem(page, ['Pane', 'Copy Last Output']);
        await waitForCondition(
          page,
          () => noticeShown(page, 'No command output to copy'),
          10000,
          async () => `the notice that there is no marked output; saw ${await notices(page)}`,
        );
        await clickMenuItem(page, ['Pane', 'Previous Prompt']);
        await waitForCondition(
          page,
          () => noticeShown(page, 'No prompt above'),
          10000,
          async () => `the notice that there is no prompt above; saw ${await notices(page)}`,
        );
        expect(await getCopyModeState(page)).toBeNull();
        return;
      }

      // The copy is written a round trip after the click, which a headless
      // browser refuses without the permission a user's browser has: the
      // notice says what the clipboard did, so it needs one that takes it.
      await page.context().grantPermissions(['clipboard-write']);
      await clickMenuItem(page, ['Pane', 'Copy Last Output']);
      await waitForCondition(
        page,
        () => page.evaluate(() => window.__tmuxyLastClipboard?.text === 'alpha\nbeta'),
        10000,
        async () =>
          `the last command's output on the clipboard; it holds ${JSON.stringify(
            await page.evaluate(() => window.__tmuxyLastClipboard ?? null),
          )}`,
      );
      await waitForCondition(
        page,
        () => noticeShown(page, 'Copied the last output: 10 characters'),
        10000,
        async () => `the notice of the copy; saw ${await notices(page)}`,
      );

      // The prompt of `printf` is still on screen, so the previous one is
      // `seq`'s, two hundred rows up: the scroll view opens with it on top.
      await clickMenuItem(page, ['Pane', 'Previous Prompt']);
      let shown = null;
      await waitForCondition(
        page,
        async () => {
          const view = await getCopyModeState(page);
          if (view?.mode !== 'scroll') return false;
          shown = await drawnRow(page, view.scrollTop);
          return !!shown?.text.startsWith('mark$ seq 1 200');
        },
        15000,
        async () =>
          `the scroll view to open on the prompt of seq; its top row reads ${JSON.stringify(shown?.text ?? null)}`,
      );
      // On the view's first visible row, with the prompt's mark at its left edge.
      expect(Math.abs(shown.line.top - shown.view.top)).toBeLessThanOrEqual(1);
      expect(shown.mark).not.toBeNull();
      expect(shown.mark.width).toBeGreaterThan(0);
      expect(Math.abs(shown.mark.top - shown.line.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(shown.mark.left - shown.view.left)).toBeLessThanOrEqual(1);

      // The next prompt is on the live screen: the view closes onto it.
      await clickMenuItem(page, ['Pane', 'Next Prompt']);
      await waitForCopyMode(page, false);
    } finally {
      shell.remove();
    }
  }, 120000);

  test('in copy mode [ and ] move the cursor from prompt to prompt', async () => {
    const { page } = ctx;
    const shell = markedShell();
    try {
      await openMarkedShell(ctx, shell);
      if (!tmuxKeepsPromptMarks(ctx)) return;

      await enterCopyModeAndWait(page);
      // The rows come from tmux a moment after the view opens: the waiting
      // prompt's own mark, on screen, says they are here.
      await waitForCondition(
        page,
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.pane-active [data-testid="prompt-mark"]')].some(
              (mark) => mark.getBoundingClientRect().width > 0,
            ),
          ),
        15000,
        'the prompts to be marked',
      );

      /** Press `key`, and wait for the cursor to be drawn on a row starting with `text`. */
      const lands = async (key, text) => {
        await page.keyboard.press(key);
        let shown = null;
        await waitForCondition(
          page,
          async () => {
            const view = await getCopyModeState(page);
            if (!view) return false;
            shown = await drawnRow(page, view.cursorRow);
            return (
              view.cursorCol === 0 &&
              !!shown?.text.startsWith(text) &&
              !!shown.cursor &&
              Math.abs(shown.cursor.top - shown.line.top) <= 1
            );
          },
          10000,
          async () =>
            `${key} to put the cursor on the row starting ${JSON.stringify(text)}; it is on ${JSON.stringify(shown?.text ?? null)}`,
        );
      };

      // The cursor starts on the waiting prompt.
      await lands('[', "mark$ printf 'alpha");
      await lands('[', 'mark$ seq 1 200');
      await lands(']', "mark$ printf 'alpha");

      await page.keyboard.press('q');
      await waitForCopyMode(page, false);
    } finally {
      shell.remove();
    }
  }, 120000);
});
