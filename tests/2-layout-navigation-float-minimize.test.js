/**
 * Layout & Navigation E2E Tests (Minimized Floats)
 */

const {
  describeE2E,
  runCommand,
  typeInTerminal,
  pressEnter,
  waitForCondition,
  verifyFloatVisible,
  waitForFloatModal,
  waitForNoModal,
  focusedFloatPaneId,
  openFloatFromCli,
} = require('./helpers/layout-helpers');

// ==================== Scenario 6f: Minimized floats ====================

describeE2E('Scenario 6f: Minimized floats', {}, (ctx) => {
  /** The queue's pills drawn on screen, by pane id: only those with a box count. */
  const pills = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-float-pill]')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 20 && box.height > 8 && box.bottom <= innerHeight;
        })
        .map((el) => el.dataset.floatPill),
    );
  // `runCommand`, not `query`: these name their own target.
  const floatTag = async (floatId) =>
    String(
      await ctx.session.runCommand(`show-options -wqv -t ${floatId} @tmuxy-float-minimized`),
    ).trim();
  const paneAlive = async (paneId) =>
    String(await ctx.session.runCommand('list-panes -a -F "#{pane_id}"'))
      .split('\n')
      .includes(paneId);

  test("minimize a float → it leaves the screen for a pill, still running, and the panes have the keyboard → the pill brings it back with the keyboard → the pill's ✕ closes it", async () => {
    await ctx.setupPage();
    const floatId = await openFloatFromCli(ctx);
    await typeInTerminal(ctx.page, 'echo FLOAT_ALIVE', {
      target: '.float-container [role="log"]',
    });
    await pressEnter(ctx.page);

    await ctx.page.click('.float-container .pane-header-minimize');
    await waitForNoModal(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await pills(ctx.page)).includes(floatId),
      10000,
      'a pill for the minimized float',
    );
    expect(await floatTag(floatId)).toBe('1');
    // Its pane is alive behind the pill, and the tiled pane takes the keys.
    expect(await paneAlive(floatId)).toBe(true);
    expect(await focusedFloatPaneId(ctx.page)).toBeNull();
    await runCommand(ctx.page, 'echo BG_WHILE_MINIMIZED', 'BG_WHILE_MINIMIZED');

    await ctx.page.click(`[data-float-pill="${floatId}"] .float-queue-restore`);
    await waitForFloatModal(ctx.page);
    await verifyFloatVisible(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => (await focusedFloatPaneId(ctx.page)) === floatId,
      5000,
      'the float back with the keyboard',
    );
    expect(await pills(ctx.page)).toEqual([]);
    expect(await floatTag(floatId)).toBe('');
    // The same shell, still running what it ran before.
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          () =>
            document.querySelector('.float-container')?.textContent?.includes('FLOAT_ALIVE') ??
            false,
        ),
      5000,
      'the float to show what it printed before',
    );

    await ctx.page.click('.float-container .pane-header-minimize');
    await waitForCondition(
      ctx.page,
      async () => (await pills(ctx.page)).length === 1,
      10000,
      'the pill again',
    );
    await ctx.page.click(`[data-float-pill="${floatId}"] .float-queue-close`);
    await waitForCondition(
      ctx.page,
      async () => (await pills(ctx.page)).length === 0 && !(await paneAlive(floatId)),
      10000,
      "the pill's ✕ to close the float",
    );
  }, 90000);
});
