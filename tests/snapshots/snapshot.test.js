/**
 * The screen against tmux: the strip's tabs, the grid's panes, their sizes and
 * their text, over a split and a second tab. It is also the nightly
 * tmux-matrix smoke (nightly-tmux-matrix.yml), so it stays a file of its own.
 * Layout geometry is 1-input Scenario 23's, at three viewports.
 */

const {
  describeE2E,
  assertScreenMatchesTmux,
  runCommand,
  splitPaneKeyboard,
  createWindowKeyboard,
  waitForWindowCount,
} = require('../helpers');

describeE2E('Snapshot: the screen matches tmux', {}, (ctx) => {
  test('a split and a second tab: the strip, the grid, every size and every line agree with tmux', async () => {
    await ctx.setupPage();
    await runCommand(ctx.page, 'echo SNAPSHOT_FIRST', 'SNAPSHOT_FIRST');
    await assertScreenMatchesTmux(ctx.page, { content: true, label: 'one pane' });
    await splitPaneKeyboard(ctx.page, 'vertical');
    await assertScreenMatchesTmux(ctx.page, { content: true, label: 'split' });

    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await runCommand(ctx.page, 'echo SNAPSHOT_SECOND', 'SNAPSHOT_SECOND');
    await assertScreenMatchesTmux(ctx.page, { content: true, label: 'second tab' });
  });
});
