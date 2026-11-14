/**
 * Layout & Navigation E2E Tests (Sidebar Tree View: a pane's custom fields)
 */

const {
  describeE2E,
  runCommand,
  openSidebarKeyboard,
  waitForCondition,
  TMUXY_CLI,
} = require('./helpers/layout-helpers');

/** The fields a row shows, and whether their line is drawn inside the column. */
async function rowFields(page, paneId) {
  return page.evaluate((id) => {
    const line = document.querySelector(
      `[data-testid="tree-pane-${id}"] [data-testid="tree-fields"]`,
    );
    if (!line) return { fields: [], inColumn: false };
    const column = document.querySelector('.sidebar-column-left').getBoundingClientRect();
    const r = line.getBoundingClientRect();
    return {
      fields: [...line.querySelectorAll('.sidebar-tree-field')].map((f) => f.textContent),
      inColumn: r.width > 0 && r.left >= column.left && r.right <= column.right + 0.5,
    };
  }, paneId);
}

// ==================== Scenario 6h: a pane's custom fields ====================

describeE2E("Scenario 6h: a pane's custom fields in the tree", {}, (ctx) => {
  test('fields set from inside a pane show on its row, one with a time to live goes when its time is up, and clear takes the rest', async () => {
    await ctx.setupPage();
    const paneId = await ctx.page.evaluate(() => window.app?.view().activePaneId);
    expect(paneId).toMatch(/^%\d+$/);

    // The user (or an agent) sets them from the pane, as they would.
    await runCommand(
      ctx.page,
      `${TMUXY_CLI} pane meta set ci=passing 'task=parser rewrite' && echo META-SET`,
      'META-SET',
    );
    await runCommand(
      ctx.page,
      `${TMUXY_CLI} pane meta set --ttl 15s deploy=running && echo META-TTL`,
      'META-TTL',
    );
    await openSidebarKeyboard(ctx.page, 'left');
    const shown = async (expected) => {
      const now = await rowFields(ctx.page, paneId);
      return now.inColumn && JSON.stringify(now.fields) === JSON.stringify(expected);
    };
    await waitForCondition(
      ctx.page,
      () => shown(['ci passing', 'deploy running', 'task parser rewrite']),
      30000,
      `the three fields on the row of ${paneId}`,
    );

    // The field with a time to live is gone once its time is up.
    await waitForCondition(
      ctx.page,
      () => shown(['ci passing', 'task parser rewrite']),
      30000,
      'deploy to leave the row once its 15 seconds were up',
    );

    // Clear takes the line away. Opening the tree left the keyboard with the
    // pane, so it is typed there like the rest.
    await runCommand(ctx.page, `${TMUXY_CLI} pane meta clear && echo META-CLEAR`, 'META-CLEAR');
    await waitForCondition(
      ctx.page,
      async () => (await rowFields(ctx.page, paneId)).fields.length === 0,
      30000,
      'the fields line to go once cleared',
    );
  });
});
