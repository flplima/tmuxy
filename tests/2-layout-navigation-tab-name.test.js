/**
 * A tab is named for its pane's directory, or for its program when tmux cannot
 * read the directory (a root process such as `top` or `sudo` on macOS). The strip hides a tab named "", so a tab whose directory
 * cannot be read must still be in it, with a name.
 */

const { describeE2E, typeInTerminal, pressEnter, waitForCondition } = require('./helpers');

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
