/**
 * A tab is named for its pane's directory, or for its program when tmux cannot
 * read the directory (a root process such as `top` or `sudo` on macOS). The strip hides a tab named "", so a tab whose directory
 * cannot be read must still be in it, with a name. A name the user gives it
 * from the shell is the name, a leading dash and all.
 */

const { describeE2E, typeInTerminal, pressEnter, waitForCondition } = require('./helpers');
const { TMUXY_CLI } = require('./helpers/cli');

describeE2E(
  'Scenario: a tab whose directory cannot be read keeps its place in the strip',
  {},
  (ctx) => {
    test('a pane running top (a root process on macOS) leaves its tab in the strip, named', async () => {
      await ctx.setupPage();
      const page = ctx.page;
      const tabs = async () => page.$$eval('.tab-name[data-window-id]', (els) => els.length);
      const before = await tabs();
      expect(before).toBeGreaterThan(0);

      await typeInTerminal(page, 'top');
      await pressEnter(page);
      await waitForCondition(
        page,
        async () => (await ctx.session.getPaneInfo()).some((p) => p.command === 'top'),
        15000,
        'top to be the pane command',
      );

      // tmux names the window after the directory or, where it cannot read
      // one, after the program: never "".
      await waitForCondition(
        page,
        async () => {
          const [window] = await ctx.session.getWindowInfo();
          const [pane] = await ctx.session.getPaneInfo();
          const cwdName = pane.cwd ? pane.cwd.split('/').pop() : null;
          return window.name === (cwdName || pane.command);
        },
        15000,
        'tmux to name the window for its directory or its program',
      );
      await waitForCondition(
        page,
        async () => (await tabs()) === before,
        10000,
        'the tab to stay in the strip',
      );
      const label = await page.$eval('.tab-name[data-window-id]', (el) =>
        el.getAttribute('aria-label'),
      );
      expect(label).toMatch(/^Tab 1: \S/);
    }, 90000);
  },
);

describeE2E('Scenario: a tab renamed from its shell', {}, (ctx) => {
  test('`tmuxy tab rename -- -1` names the tab -1 in the strip', async () => {
    await ctx.setupPage();
    const page = ctx.page;

    // The name is rename-window's operand. Without `--` before it, tmux
    // read `-1` as a flag and refused the rename ("unknown flag -1").
    await typeInTerminal(page, `${TMUXY_CLI} tab rename -- -1`);
    await pressEnter(page);
    const shown = () =>
      page.$eval('.tab-name[data-window-id] .tab-name-label', (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? el.textContent.trim() : null;
      });
    await waitForCondition(
      page,
      async () => (await shown()) === '-1',
      15000,
      async () => {
        return `the tab to show "-1" (shows ${JSON.stringify(await shown())})`;
      },
    );
  }, 60000);

  test('`tmuxy tab create -- -2` opens a tab named -2 in the strip', async () => {
    await ctx.setupPage();
    const page = ctx.page;

    // Without `--` a word that starts with a dash is a bad option; after it
    // the word is the new tab's name.
    await typeInTerminal(page, `${TMUXY_CLI} tab create -- -2`);
    await pressEnter(page);
    const names = () =>
      page.$$eval('.tab-name[data-window-id] .tab-name-label', (els) =>
        els
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map((el) => el.textContent.trim()),
      );
    await waitForCondition(
      page,
      async () => (await names()).includes('-2'),
      15000,
      async () => {
        return `a tab named "-2" in the strip (shows ${JSON.stringify(await names())})`;
      },
    );
  }, 60000);
});
