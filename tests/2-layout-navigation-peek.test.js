/**
 * Layout & Navigation E2E Tests (a closed sidebar peeking on hover)
 *
 * Resting the mouse on a closed sidebar's header toggle shows the column over
 * the panes, with the rest of the body dimmed behind it, and the pointer
 * leaving puts it away — the way a collapsed sidebar comes out in the Claude
 * desktop app. The grid under it keeps its size, the column's window stays
 * hidden in tmux, and only a click on the toggle docks it.
 */

const {
  describeE2E,
  openSession,
  waitForCondition,
  waitForTerminalText,
  afterFrames,
} = require('./helpers');
const { tmuxPane } = require('./helpers/tmux-read');
const { tmuxExec } = require('./helpers/tmux-socket');

/** Where things are on screen, as the user sees them. */
const geometry = async (page) => {
  const drawn = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const backdrop = document.querySelector('.sidebar-peek-backdrop');
    return {
      toggle: rect('.sidebar-toggle-left'),
      peek: rect('.sidebar-column-left.is-peek'),
      docked: rect('.sidebar-column-left:not(.is-peek)'),
      backdrop: rect('.sidebar-peek-backdrop'),
      backdropColor: backdrop ? getComputedStyle(backdrop).backgroundColor : null,
      container: rect('.pane-container'),
      pane: rect('.pane-layout-item'),
      treeRow: rect('.sidebar-column-left.is-peek .sidebar-tree-tab'),
      activePaneId: window.app.view().activePaneId,
    };
  });
  // What tmux holds: the tree's window hidden from every client, and the
  // active pane's width in cells.
  const session = new URL(page.url()).searchParams.get('session');
  const tree = tmuxExec(
    `list-windows -t ${session} -F '#{@tmuxy-window-type} #{@tmuxy-sidebar-hidden}'`,
  )
    .split('\n')
    .find((line) => line.startsWith('sidebar-left'));
  const { activePaneId, ...rest } = drawn;
  return {
    ...rest,
    treeHidden: tree ? tree.split(' ')[1] === '1' : null,
    paneCols: activePaneId ? tmuxPane(activePaneId).width : null,
  };
};

const centre = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

/**
 * Watch `holds` for `ms` and fail the moment it stops holding: a claim that
 * something STAYS, which a single look cannot make. The span is the app's
 * own grace periods over again (useSidebarPeek: 150 ms to open, 300 ms to
 * close), so a wrong answer has had time to show.
 */
async function holdsFor(page, ms, holds, what) {
  const start = Date.now();
  await waitForCondition(
    page,
    async () => {
      if (!(await holds())) {
        const desc = typeof what === 'function' ? await what() : what;
        throw new Error(`${desc} stopped holding after ${Date.now() - start}ms`);
      }
      return Date.now() - start >= ms;
    },
    ms + 10000,
    what,
  );
}

describeE2E('Scenario 6g: a closed sidebar peeks over the panes on hover', {}, (ctx) => {
  test('a rest on the tree toggle shows the tree over a dimmed, unchanged grid → it holds while the mouse is on it → leaving puts it away and the keyboard is still the pane’s → the toggle’s click docks it', async () => {
    await ctx.setupPage();
    const page = ctx.page;
    await openSession(page, ctx.session.name);

    const before = await geometry(page);
    expect(before.peek).toBeNull();
    expect(before.docked).toBeNull();

    // 1. The mouse comes to rest on the toggle. The tree was never opened, so
    //    the peek also makes its pane.
    const toggle = centre(before.toggle);
    await page.mouse.move(toggle.x, toggle.y);
    await waitForCondition(
      page,
      async () => {
        const g = await geometry(page);
        // Settled: the column slides in from the edge.
        return g.peek && g.treeRow && g.peek.width > 50 && Math.abs(g.peek.left) <= 1;
      },
      15000,
      'the tree to come out to the window’s edge with its tab row',
    );

    // 2. Over the panes, not beside them: at the window's left edge, the
    //    tab row inside it, the backdrop over the whole grid, and the grid
    //    exactly where and as wide as it was, in pixels and in tmux cells.
    await afterFrames(page, 3);
    const peeking = await geometry(page);
    expect(peeking.treeRow.left).toBeGreaterThanOrEqual(peeking.peek.left);
    expect(peeking.treeRow.right).toBeLessThanOrEqual(peeking.peek.right + 1);
    expect(peeking.backdrop.left).toBeLessThanOrEqual(peeking.pane.left);
    expect(peeking.backdrop.right).toBeGreaterThanOrEqual(peeking.pane.right);
    expect(peeking.backdrop.top).toBeLessThanOrEqual(peeking.pane.top);
    expect(peeking.backdropColor).toMatch(/^rgba\(0, 0, 0, 0?\.\d+\)$/);
    expect(peeking.container).toEqual(before.container);
    expect(peeking.pane).toEqual(before.pane);
    expect(peeking.paneCols).toBe(before.paneCols);
    expect(peeking.docked).toBeNull();
    // The tree's window arrives hidden: no other client sees it open.
    await waitForCondition(
      page,
      async () => (await geometry(page)).treeHidden === true,
      10000,
      'the tree’s window to be hidden in tmux',
    );

    // 3. The mouse moves off the toggle into the column and stays there past
    //    the grace period: the tree stays out.
    const row = centre(peeking.treeRow);
    await page.mouse.move(row.x, row.y, { steps: 5 });
    await holdsFor(
      page,
      800,
      async () => (await geometry(page)).peek !== null,
      'the peek while the mouse is on it',
    );

    // 4. Onto the panes: the tree goes, nothing docked, and what is typed
    //    with no click lands in the pane.
    const pane = centre(peeking.pane);
    await page.mouse.move(pane.x, pane.y, { steps: 5 });
    await waitForCondition(
      page,
      async () => (await geometry(page)).peek === null,
      5000,
      'the peek to go once the mouse left it',
    );
    const after = await geometry(page);
    expect(after.docked).toBeNull();
    expect(after.backdrop).toBeNull();
    expect(after.container).toEqual(before.container);
    await page.keyboard.type('echo PEEK_KEYS_OK', { delay: 10 });
    await page.keyboard.press('Enter');
    await waitForTerminalText(page, 'PEEK_KEYS_OK', 15000, { notOnLineWith: 'echo' });

    // 5. Back on the toggle, and a click: the tree docks beside the grid,
    //    which gives it its width.
    await page.mouse.move(toggle.x, toggle.y, { steps: 5 });
    await waitForCondition(page, async () => (await geometry(page)).peek, 10000, 'a second peek');
    await page.mouse.click(toggle.x, toggle.y);
    await waitForCondition(
      page,
      async () => {
        const g = await geometry(page);
        return g.docked && !g.peek && g.container.width < before.container.width - 50;
      },
      10000,
      'the tree to dock and the grid to make room',
    );
    expect((await geometry(page)).backdrop).toBeNull();

    // The same click shuts it again, and with the pointer still on the
    // toggle it does not come straight back out.
    await page.mouse.click(toggle.x, toggle.y);
    await waitForCondition(
      page,
      async () => (await geometry(page)).docked === null,
      10000,
      'the tree to shut',
    );
    let shut = null;
    await holdsFor(
      page,
      600,
      async () => {
        shut = await geometry(page);
        return shut.docked === null && shut.peek === null;
      },
      () =>
        `the tree staying shut under the pointer (docked: ${JSON.stringify(shut.docked)}, peek: ${JSON.stringify(shut.peek)})`,
    );
  }, 120000);
});
