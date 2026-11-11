/**
 * Layout & Navigation E2E Tests (Sidebar Tree View: the row template)
 */

const {
  describeE2E,
  runCommand,
  openSidebarKeyboard,
  waitForCondition,
  TMUXY_CLI,
} = require('./helpers/layout-helpers');

/** Each drawn line of a pane's row, top to bottom, as its class and text. */
async function rowLines(page, paneId) {
  return page.evaluate((id) => {
    const label = document.querySelector(`[data-testid="tree-pane-${id}"] .sidebar-tree-label`);
    if (!label) return null;
    return [...label.querySelectorAll(':scope > *')]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => ({
        kind: el.className.split(' ')[0],
        text: el.textContent,
        hasId: Boolean(el.querySelector('.sidebar-tree-id')),
      }));
  }, paneId);
}

// ==================== Scenario 6i: the tree row template ====================

describeE2E('Scenario 6i: the tree row template', {}, (ctx) => {
  test('@tmuxy-tree-row orders and trims a pane row, one it cannot read leaves the default, and unset brings it back', async () => {
    await ctx.setupPage();
    const paneId = await ctx.page.evaluate(() => window.app?.view().activePaneId);
    expect(paneId).toMatch(/^%\d+$/);
    await runCommand(
      ctx.page,
      `${TMUXY_CLI} pane meta set ci=passing task=other && echo META-SET`,
      'META-SET',
    );
    await openSidebarKeyboard(ctx.page, 'left');
    const isDefault = (lines) =>
      lines?.[0]?.kind === 'sidebar-tree-line' &&
      lines[0].hasId &&
      lines.some((l) => l.kind === 'sidebar-tree-fields' && l.text.includes('task other'));
    await waitForCondition(
      ctx.page,
      async () => isDefault(await rowLines(ctx.page, paneId)),
      30000,
      'the default row: process and id first, the fields last',
    );

    // The option outlives the test on the shared server: it is unset
    // whatever happens.
    try {
      // The user's template: one field first, then the process with no id.
      // An option is the user's to set (tmuxy.conf), so the harness sets it.
      await ctx.session.runAsOperator(`set -g @tmuxy-tree-row 'field:ci / process'`);
      await waitForCondition(
        ctx.page,
        async () => {
          const lines = await rowLines(ctx.page, paneId);
          return (
            lines?.length === 2 &&
            lines[0].text === 'ci passing' &&
            lines[1].kind === 'sidebar-tree-line' &&
            !lines[1].hasId &&
            !lines.some((l) => l.text.includes('task'))
          );
        },
        30000,
        'the row as the template says: the ci field, then the process, nothing else',
      );

      // A word it does not know: the whole template is set aside.
      await ctx.session.runAsOperator(`set -g @tmuxy-tree-row 'field:ci / colour'`);
      await waitForCondition(
        ctx.page,
        async () => isDefault(await rowLines(ctx.page, paneId)),
        30000,
        'the default row again for a template it cannot read',
      );

      // Unset: the default, as before.
      await ctx.session.runAsOperator(`set -g @tmuxy-tree-row 'process'`);
      await waitForCondition(
        ctx.page,
        async () => (await rowLines(ctx.page, paneId))?.length === 1,
        30000,
        'a one-line row',
      );
    } finally {
      await ctx.session.runAsOperator('set -gu @tmuxy-tree-row');
    }
    await waitForCondition(
      ctx.page,
      async () => isDefault(await rowLines(ctx.page, paneId)),
      30000,
      'the default row once the option is unset',
    );
  });
});
