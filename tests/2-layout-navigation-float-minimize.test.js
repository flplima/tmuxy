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
  tmuxyCli,
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
  /**
   * What leads a pill, as drawn: the state its mark shows (`is-<state>`),
   * `icon` for the program's icon, or null while nothing with a box is there.
   */
  const pillFace = (page, floatId) =>
    page.evaluate((id) => {
      const face = document.querySelector(`[data-float-pill="${id}"] .pane-tab-icon`);
      if (!face) return null;
      const box = face.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return null;
      const state = [...face.classList].find((name) => name.startsWith('is-'));
      if (state) return state.slice('is-'.length);
      return face.querySelector('.process-icon-svg') || face.textContent.trim() ? 'icon' : null;
    }, floatId);

  test("a minimized float's pill leads with the pane's icon → it follows the pane's state: working, waiting, failed → back to the program's icon when the state clears", async () => {
    await ctx.setupPage();
    const floatId = await openFloatFromCli(ctx);
    await ctx.page.click('.float-container .pane-header-minimize');
    await waitForNoModal(ctx.page);
    const faceBecomes = (want) =>
      waitForCondition(
        ctx.page,
        async () => (await pillFace(ctx.page, floatId)) === want,
        10000,
        async () => `the pill to lead with ${want}; it shows ${await pillFace(ctx.page, floatId)}`,
      );

    await faceBecomes('icon');
    for (const state of ['working', 'needs-input', 'error']) {
      tmuxyCli(['pane', 'state', state, floatId]);
      await faceBecomes(state);
    }
    tmuxyCli(['pane', 'state', 'clear', floatId]);
    await faceBecomes('icon');

    await ctx.page.click(`[data-float-pill="${floatId}"] .float-queue-close`);
    await waitForCondition(
      ctx.page,
      async () => (await pills(ctx.page)).length === 0,
      10000,
      "the pill's ✕ to close the float",
    );
  }, 90000);

  /** Every pill's box, by pane id, with the box of the tab area the queue sits in. */
  const pillBoxes = (page) =>
    page.evaluate(() => {
      const queue = document.querySelector('.float-queue');
      const area = queue.offsetParent.getBoundingClientRect();
      const boxes = {};
      for (const el of document.querySelectorAll('[data-float-pill]')) {
        const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
        boxes[el.dataset.floatPill] = { left, right, top, bottom, width, height };
      }
      return { areaRight: area.right, boxes };
    });

  test('three minimized floats → side by side on one row at the right end, the first against the edge → restoring one leaves the others where they were', async () => {
    await ctx.setupPage();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await openFloatFromCli(ctx));
      await ctx.page.click('.float-container .pane-header-minimize');
      await waitForNoModal(ctx.page);
      await waitForCondition(
        ctx.page,
        async () => (await pills(ctx.page)).length === i + 1,
        10000,
        `${i + 1} pill(s) on screen`,
      );
    }
    expect(new Set(ids).size).toBe(3);

    const { areaRight, boxes } = await pillBoxes(ctx.page);
    const [first, second, third] = ids.map((id) => boxes[id]);
    // One row: the same top, none over another.
    expect(second.top).toBeCloseTo(first.top, 0);
    expect(third.top).toBeCloseTo(first.top, 0);
    // In the order they were minimized, from the right edge leftwards.
    expect(second.right).toBeLessThanOrEqual(first.left);
    expect(third.right).toBeLessThanOrEqual(second.left);
    // The first sits at the tab area's right end.
    expect(areaRight - first.right).toBeGreaterThanOrEqual(0);
    expect(areaRight - first.right).toBeLessThan(40);

    await ctx.page.click(`[data-float-pill="${ids[1]}"] .float-queue-restore`);
    await waitForFloatModal(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => !(await pills(ctx.page)).includes(ids[1]),
      10000,
      'the restored float to leave the queue',
    );
    const after = await pillBoxes(ctx.page);
    expect(Object.keys(after.boxes).sort()).toEqual([ids[0], ids[2]].sort());
    expect(after.boxes[ids[0]].right).toBeCloseTo(first.right, 0);
    expect(after.boxes[ids[2]].top).toBeCloseTo(first.top, 0);
    expect(after.boxes[ids[2]].right).toBeLessThanOrEqual(after.boxes[ids[0]].left);
    expect(after.areaRight - after.boxes[ids[0]].right).toBeLessThan(40);
  }, 180000);
});
