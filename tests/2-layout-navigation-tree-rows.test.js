/**
 * Layout & Navigation E2E Tests (the tree's rows: band, hover, fold)
 *
 * The tree in the left column is the app's own widget, not a program drawn in
 * a terminal. Its current tab wears a rounded band held in from the column's
 * edges, a row under the mouse brightens its text, and a tab's chevron folds
 * its panes away and back over a short transition — in one step when the
 * browser asks for reduced motion.
 */

const {
  describeE2E,
  openSidebarKeyboard,
  createWindowKeyboard,
  splitPaneKeyboard,
  waitForWindowCount,
  waitForCondition,
  afterFrames,
} = require('./helpers/layout-helpers');

/** The first tab's group of pane rows, its chevron and its rows, as drawn. */
const firstTab = (page) =>
  page.evaluate(() => {
    // Not drawn yet: nothing to measure, and the wait polls again.
    const tab = document.querySelector('.sidebar-tree-tab');
    if (!tab) return { height: null, inert: null, chevron: null, rows: [], ids: [] };
    const group = tab.nextElementSibling;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        height: r.height,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      };
    };
    return {
      height: group ? group.getBoundingClientRect().height : null,
      inert: group ? group.inert : null,
      chevron: rect(tab.querySelector('.sidebar-tree-chevron')),
      rows: group ? [...group.querySelectorAll('.sidebar-tree-pane')].map(rect) : [],
      ids: group
        ? [...group.querySelectorAll('.sidebar-tree-pane')].map((el) => el.dataset.paneId)
        : [],
    };
  });

/** Click the first tab's chevron and record its group's height every frame until it settles. */
const foldSamples = (page, chevron) =>
  Promise.all([
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const group = document.querySelector('.sidebar-tree-tab').nextElementSibling;
          const heights = [group.getBoundingClientRect().height];
          let still = 0;
          const tick = () => {
            const h = group.getBoundingClientRect().height;
            still = h === heights[heights.length - 1] ? still + 1 : 0;
            heights.push(h);
            // Settled: unchanged for ten frames after it first moved, or never moved.
            if (still >= 10 && (heights.some((v) => v !== heights[0]) || heights.length > 120)) {
              resolve(heights);
            } else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    ),
    page.mouse.click(chevron.x, chevron.y),
  ]).then(([heights]) => heights);

const between = (heights, a, b) =>
  heights.filter((h) => h > Math.min(a, b) + 0.5 && h < Math.max(a, b) - 0.5);

describeE2E('Scenario 6h: the tree’s rows', {}, (ctx) => {
  test('the current tab wears a rounded band inside the column → a hovered row brightens → a chevron folds a tab’s panes away and back, out of reach while folded → in one step under reduced motion', async () => {
    await ctx.setupPage();
    const page = ctx.page;

    // Two panes in the first tab, and a second tab, which is then current.
    await splitPaneKeyboard(page, 'vertical');
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 2);
    await openSidebarKeyboard(page, 'left');
    await waitForCondition(
      page,
      async () => (await firstTab(page)).rows.length === 2,
      15000,
      'the tree to list the first tab’s two panes',
    );

    // 1. The tree is the app's widget: no terminal drawn in its column.
    const widget = await page.evaluate(() => ({
      tree: !!document.querySelector('.sidebar-column-left .sidebar-tree'),
      terminal: !!document.querySelector('.sidebar-column-left .terminal-content'),
    }));
    expect(widget).toEqual({ tree: true, terminal: false });

    // 2. The current tab's band: rounded, clear of both column edges, and
    //    taller than the name it holds.
    const band = await page.evaluate(() => {
      const col = document.querySelector('.sidebar-column-left').getBoundingClientRect();
      const row = document.querySelector('.sidebar-tree-tab.is-active');
      const r = row.getBoundingClientRect();
      const label = row.querySelector('.sidebar-tree-name').getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        insetLeft: r.left - col.left,
        insetRight: col.right - r.right,
        radius: parseFloat(style.borderTopLeftRadius),
        bg: style.backgroundColor,
        roomAbove: label.top - r.top,
        roomBelow: r.bottom - label.bottom,
      };
    });
    expect(band.insetLeft).toBeGreaterThanOrEqual(2);
    expect(band.insetRight).toBeGreaterThanOrEqual(2);
    expect(band.radius).toBeGreaterThan(0);
    expect(band.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(band.roomAbove).toBeGreaterThanOrEqual(2);
    expect(band.roomBelow).toBeGreaterThanOrEqual(2);

    // 3. The mouse on a pane row of the other tab: its text brightens to the
    //    theme's primary ink.
    const before = await firstTab(page);
    const inkOf = () =>
      page.evaluate(() => {
        const name = document.querySelector('.sidebar-tree-pane .sidebar-tree-name');
        const probe = document.createElement('span');
        probe.style.color = 'var(--text-primary)';
        document.body.appendChild(probe);
        const out = { ink: getComputedStyle(name).color, primary: getComputedStyle(probe).color };
        probe.remove();
        return out;
      });
    // The pointer is wherever an earlier step left it, which can be on this
    // very row: away from the tree first, or "resting" is the hover ink.
    const away = await page.evaluate(() => [window.innerWidth - 4, window.innerHeight - 4]);
    await page.mouse.move(away[0], away[1]);
    await waitForCondition(
      page,
      async () => page.evaluate(() => !document.querySelector('.sidebar-tree-pane:hover')),
      5000,
      'no tree row under the pointer',
    );
    const resting = await inkOf();
    expect(resting.ink).not.toBe(resting.primary);
    await page.mouse.move(before.rows[0].x, before.rows[0].y);
    await waitForCondition(
      page,
      async () => {
        const now = await inkOf();
        return now.ink === now.primary;
      },
      5000,
      'the hovered row’s name to brighten',
    );

    // 4. The chevron folds the tab: the group closes through heights in
    //    between, to nothing, and what was a row there is out of reach.
    const full = before.height;
    expect(full).toBeGreaterThan(10);
    const closing = await foldSamples(page, before.chevron);
    expect(closing[closing.length - 1]).toBe(0);
    expect(between(closing, 0, full).length).toBeGreaterThan(0);
    const folded = await firstTab(page);
    expect(folded.inert).toBe(true);
    // The rows below have moved up into its place: what is under the
    // pointer there now is the next tab's, never one of the folded panes.
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.sidebar-tree-pane')?.dataset.paneId ?? null,
      before.rows[1],
    );
    expect(before.ids).not.toContain(hit);

    // 5. And unfolds it the same way, its rows back where they were.
    const opening = await foldSamples(page, folded.chevron);
    expect(opening[opening.length - 1]).toBeCloseTo(full, 0);
    expect(between(opening, 0, full).length).toBeGreaterThan(0);
    const unfolded = await firstTab(page);
    expect(unfolded.inert).toBe(false);
    expect(unfolded.rows.map((r) => Math.round(r.top))).toEqual(
      before.rows.map((r) => Math.round(r.top)),
    );

    // 6. With reduced motion asked for, the fold is one step either way.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await afterFrames(page, 2);
    const instantClose = await foldSamples(page, unfolded.chevron);
    expect(between(instantClose, 0, full)).toEqual([]);
    expect(instantClose[instantClose.length - 1]).toBe(0);
    const instantOpen = await foldSamples(page, (await firstTab(page)).chevron);
    expect(between(instantOpen, 0, full)).toEqual([]);
    await page.emulateMedia({ reducedMotion: null });
  }, 120000);
});
