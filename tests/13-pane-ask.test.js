/**
 * `tmuxy pane ask` — a script or an agent asks the person a question over
 * its own pane and waits for the answer.
 *
 * The whole round trip, through the real chain: the CLI typed into a real
 * shell, the `@tmuxy-ask` option on a real tmux server, the question drawn
 * over the pane, the answer clicked in the browser, and the CLI printing it
 * and exiting, with the overlay gone and the pane saying what it said before.
 */

const {
  TMUXY_CLI,
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  waitForShellPrompt,
  splitPaneKeyboard,
  waitForPaneCount,
  waitForCondition,
  paneHeaderMark,
} = require('./helpers');
const { tmuxyCli } = require('./helpers/cli');

/** What a pane's terminal shows. */
async function screenOf(page, paneId) {
  return page.evaluate(
    (id) => document.querySelector(`[data-pane-id="${id}"] [role="log"]`)?.textContent ?? '',
    paneId,
  );
}

/** The question over `paneId` once it is on screen: its parts' boxes and words. */
async function seenQuestion(page, paneId) {
  return page.evaluate((id) => {
    const overlay = document.querySelector(`[data-pane-ask="${id}"]`);
    if (!overlay) return null;
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
    };
    return {
      pane: box(overlay),
      caller: overlay.querySelector('.ask-overlay-caller')?.textContent ?? '',
      prompt: overlay.querySelector('.ask-overlay-prompt')?.textContent ?? '',
      choices: [...overlay.querySelectorAll('[data-ask-choice]')].map((b) => ({
        text: b.textContent,
        box: box(b),
      })),
    };
  }, paneId);
}

describeE2E(
  'Scenario: tmuxy pane ask puts a question over a pane and prints the answer',
  {},
  (ctx) => {
    test('a question asked in a pane is answered with a click: the CLI prints the choice and exits 0, the pane gets its state back', async () => {
      const { page } = ctx;
      await ctx.setupPage();
      await waitForShellPrompt(page);
      // Two panes, so the pane asking has a header that shows its state.
      await splitPaneKeyboard(page, 'horizontal');
      await waitForPaneCount(page, 2);
      await waitForShellPrompt(page);
      const here = await page.evaluate(() => window.app.view().activePaneId);
      const scope = `[data-pane-id="${here}"]`;

      // What the pane said before: an agent at work.
      tmuxyCli(['pane', 'state', 'working', here]);
      await waitForCondition(
        page,
        async () => (await paneHeaderMark(page, here)) === 'working',
        10000,
        'the pane to show it is working',
      );

      await typeInTerminal(
        page,
        `a=$(${TMUXY_CLI} pane ask "Deploy?" --choice yes --choice no); echo "answer=[$a] exit=$?"`,
        { target: `${scope} [role="log"]` },
      );
      await pressEnter(page);

      let why = 'it never appeared';
      const question = await waitForCondition(
        page,
        async () => {
          const seen = await seenQuestion(page, here);
          const yes = seen?.choices[0]?.box;
          if (yes && yes.width > 20 && yes.height > 10) return seen;
          if (seen) why = `its first choice is ${JSON.stringify(yes)}`;
          return null;
        },
        20000,
        async () =>
          `the question over ${here} to be visible (${why}); the pane shows ${JSON.stringify((await screenOf(page, here)).slice(-600))}`,
      );
      expect(question.caller).toBeTruthy();
      expect(question.prompt).toBe('Deploy?');
      expect(question.choices.map((c) => c.text)).toEqual(['1.yes', '2.no']);
      for (const { box } of question.choices) {
        expect(box.top).toBeGreaterThanOrEqual(question.pane.top);
        expect(box.bottom).toBeLessThanOrEqual(question.pane.bottom);
      }
      // The pane asking needs the person while the question is up.
      await waitForCondition(
        page,
        async () => (await paneHeaderMark(page, here)) === 'needs-input',
        10000,
        'the pane to show it needs input',
      );

      await page.click(`[data-pane-ask="${here}"] [data-ask-choice="0"]`);
      await waitForCondition(
        page,
        () => page.evaluate((id) => !document.querySelector(`[data-pane-ask="${id}"]`), here),
        15000,
        'the answered question to leave the screen',
      );
      await waitForTerminalText(page, 'answer=[yes] exit=0', 20000, { scope });
      await waitForCondition(
        page,
        async () => (await paneHeaderMark(page, here)) === 'working',
        10000,
        'the pane to say it is working again',
      );
    }, 120000);
  },
);
