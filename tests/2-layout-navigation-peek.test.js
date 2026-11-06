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
  createTestContext,
  navigateToSession,
  waitForSessionReady,
  waitForCondition,
  waitForTerminalText,
  afterFrames,
} = require('./helpers');

/** Where things are on screen, as the user sees them. */
const geometry = (page) =>
  page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const ctx = window.app?.getSnapshot()?.context;
    const tree = ctx?.windows?.find((w) => w.windowType === 'sidebar-left');
    const active = ctx?.panes?.find((p) => p.tmuxId === ctx.activePaneId);
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
      treeHidden: tree ? Boolean(tree.sidebarHidden) : null,
      paneCols: active?.width ?? null,
      open: ctx?.sidebars?.left?.open,
    };
  });

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
      if (!(await holds()))
        throw new Error(`${what} stopped holding after ${Date.now() - start}ms`);
      return Date.now() - start >= ms;
    },
    ms + 10000,
    what,
  );
}

describe('Scenario 6g: a closed sidebar peeks over the panes on hover', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a rest on the tree toggle shows the tree over a dimmed, unchanged grid → it holds while the mouse is on it → leaving puts it away and the keyboard is still the pane’s → the toggle’s click docks it', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    await navigateToSession(page, ctx.session.name);
    await waitForSessionReady(page, ctx.session.name);

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
    expect(peeking.open).toBe(false);
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
    await holdsFor(
      page,
      600,
      async () => {
        const g = await geometry(page);
        return g.docked === null && g.peek === null;
      },
      'the tree staying shut under the pointer',
    );
  }, 120000);
});
