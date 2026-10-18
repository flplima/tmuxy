/**
 * Layout & Navigation E2E Tests (2x2 Zoom & Drag Pane to Tab Strip)
 */

const {
  createTestContext,
  delay,
  waitForPaneCount,
  waitForWindowCount,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  sendPrefixCommand,
  createWindowKeyboard,
  selectWindowKeyboard,
  assertLayoutInvariants,
  waitForCondition,
} = require('./helpers/layout-helpers');

// ==================== Scenario 4c: Zoom in a 2×2 grid ====================

describe('Scenario 4c: Zoom in a 2×2 grid', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The zoomed pane used to be identified as "the first pane whose far corner
  // touches the grid's far corner" — which the bottom-right pane of any grid
  // does. Zooming the top-left pane therefore hid it and left the bottom-right
  // pane sitting in its quarter slot. The zoomed pane must be the one that
  // spans the whole grid, whichever pane it is.
  test('zooming the top-left pane shows that pane full size and hides the others; unzoom restores all four [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // 2×2: split right, then split each column down.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await navigatePaneKeyboard(ctx.page, 'left');
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4);

    const visiblePanes = () =>
      ctx.page.evaluate(() => {
        const ctxState = window.app?.getSnapshot()?.context;
        return (ctxState?.panes || [])
          .filter((p) => p.windowId === ctxState.activeWindowId)
          .map((p) => {
            const el = document.querySelector(`.pane-container [data-pane-id="${p.tmuxId}"]`);
            const r = el?.getBoundingClientRect();
            return {
              id: p.tmuxId,
              w: Math.round(r?.width ?? 0),
              h: Math.round(r?.height ?? 0),
              opacity: el ? Number(getComputedStyle(el).opacity) : 0,
            };
          });
      });

    // Zoom the TOP-LEFT pane (x=0, y=top). Navigate there first.
    await navigatePaneKeyboard(ctx.page, 'up');
    const zoomTarget = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    const targetGeometry = await ctx.page.evaluate(
      (id) => window.app?.getSnapshot()?.context?.panes?.find((p) => p.tmuxId === id),
      zoomTarget,
    );
    expect(targetGeometry.x).toBe(0);

    const before = await visiblePanes();
    const quarterW = Math.max(...before.map((p) => p.w));
    const quarterH = Math.max(...before.map((p) => p.h));

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed)),
      8000,
      'tmux to report the window zoomed',
    );
    // The other panes fade out by CSS transition: read them once it is done.
    await waitForCondition(
      ctx.page,
      async () => (await visiblePanes()).filter((p) => p.opacity > 0.99).length === 1,
      5000,
      'the zoom to leave one pane shown',
    );

    const zoomed = await visiblePanes();
    const shown = zoomed.filter((p) => p.opacity > 0.99);
    expect(shown.map((p) => p.id)).toEqual([zoomTarget]);
    // The zoomed pane grew to the grid: about twice a quarter in each direction.
    expect(shown[0].w).toBeGreaterThan(quarterW * 1.8);
    expect(shown[0].h).toBeGreaterThan(quarterH * 1.8);

    await sendPrefixCommand(ctx.page, 'z');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => !window.app?.getSnapshot()?.context?.windows?.some((w) => w.zoomed),
        ),
      8000,
      'tmux to report the window un-zoomed',
    );
    await waitForCondition(
      ctx.page,
      async () => (await visiblePanes()).filter((p) => p.opacity > 0.99).length === 4,
      5000,
      'the un-zoom to show all four panes again',
    );
    const restored = await visiblePanes();
    expect(restored.filter((p) => p.opacity > 0.99).length).toBe(4);
    await assertLayoutInvariants(ctx.page);
  }, 120000);

  // An even 2×2 grid built column by column: the two row lines happen to line
  // up, but tmux resizes each column's on its own. Dragging the left one used
  // to draw the right column moving too — a layout tmux never produced, so the
  // preview hung on until its fallback timer gave up.
  test('in a grid split into columns, dragging one column’s row divider moves that column only', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 3);
    await navigatePaneKeyboard(ctx.page, 'left');
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 4);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          return Boolean(c?.windows?.find((w) => w.id === c.activeWindowId)?.paneTree);
        }),
      8000,
      'the window to report its split structure',
    );

    // Where each pane is drawn, keyed by which quarter of the grid it sits in.
    const quarters = () =>
      ctx.page.evaluate(() => {
        const c = window.app.getSnapshot().context;
        const panes = c.panes.filter((p) => p.windowId === c.activeWindowId);
        const midX = Math.max(...panes.map((p) => p.x)) / 2;
        const midY = Math.max(...panes.map((p) => p.y)) / 2;
        const out = {};
        for (const p of panes) {
          const el = document.querySelector(`.pane-container [data-pane-id="${p.tmuxId}"]`);
          const r = el.getBoundingClientRect();
          const key = `${p.y < midY ? 'top' : 'bottom'}-${p.x < midX ? 'left' : 'right'}`;
          out[key] = { top: Math.round(r.top), height: Math.round(r.height) };
        }
        return out;
      });

    // Each column has its own row divider: two ns-resize handles, side by side.
    const rowDividers = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.resize-divider')]
        .filter((d) => d.style.cursor === 'ns-resize')
        .map((d) => {
          const r = d.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, width: r.width };
        })
        .sort((a, b) => a.left - b.left),
    );
    expect(rowDividers).toHaveLength(2);
    const [leftDivider] = rowDividers;

    const before = await quarters();
    const rowPx = await ctx.page.evaluate(() => window.app.getSnapshot().context.charHeight);

    await ctx.page.mouse.move(leftDivider.x, leftDivider.y);
    await ctx.page.mouse.down();
    for (let step = 1; step <= 3; step++) {
      await ctx.page.mouse.move(leftDivider.x, leftDivider.y + step * rowPx);
    }
    // Mid-drag, as drawn: the left column moved, the right one did not.
    await waitForCondition(
      ctx.page,
      async () => (await quarters())['top-left'].height > before['top-left'].height,
      8000,
      'the preview to draw the drag',
    );
    const during = await quarters();
    expect(during['top-right']).toEqual(before['top-right']);
    expect(during['bottom-right']).toEqual(before['bottom-right']);
    await ctx.page.mouse.up();

    // And tmux agrees: the preview lets go once its layout has landed.
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => window.app.getSnapshot().context.resize === null),
      8000,
      'the resize preview to settle',
    );
    const after = await quarters();
    expect(after['top-left'].height).toBeGreaterThan(before['top-left'].height);
    expect(after['top-right']).toEqual(before['top-right']);
    expect(after['bottom-right']).toEqual(before['bottom-right']);
    await assertLayoutInvariants(ctx.page);
  }, 120000);
});

// ==================== Scenario 4g: Drag a pane onto the tab strip ====================

describe('Scenario 4g: Drag a pane onto the tab strip', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** How many panes each window holds, keyed by tmux window id. */
  const panesByWindow = async () => {
    const counts = {};
    const out = await ctx.session.query("list-panes -s -F '#{window_id}'");
    for (const line of String(out).split('\n')) {
      if (line) counts[line] = (counts[line] || 0) + 1;
    }
    return counts;
  };

  /**
   * The box of the header of the last pane in the VISIBLE tab.
   *
   * Every tab's panes are in the document and only one tab's are on screen, so
   * "the last header" can belong to the tab being dragged to — and a pane
   * dropped on the tab it already lives in goes nowhere.
   */
  const secondPaneHeaderBox = (page) =>
    page.evaluate(() => {
      const ctx = window.app.getSnapshot().context;
      const here = new Set(
        ctx.panes.filter((p) => p.windowId === ctx.activeWindowId).map((p) => p.tmuxId),
      );
      const items = [...document.querySelectorAll('.pane-layout-item')].filter((item) =>
        here.has(item.querySelector('[data-pane-id]')?.dataset.paneId),
      );
      const item = items[items.length - 1];
      const r = item.querySelector('.pane-header').getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        paneId: item.querySelector('[data-pane-id]').dataset.paneId,
      };
    });

  /**
   * Press on the header and travel to (x, y) in steps, so the 5px threshold
   * that turns a press into a drag is crossed the way a hand crosses it.
   */
  const dragHeaderTo = async (page, from, x, y) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const t of [0.15, 0.4, 0.7, 1]) {
      await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await delay(60);
    }
  };

  // Dragging a pane's header up onto another tab's button moves the pane into
  // that tab. While the pointer is over it the button says so, because a drop
  // that silently rearranges two tabs is not something to find out afterwards.
  test('drag a pane onto another tab: the tab highlights, and the drop moves the pane there', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // A second tab to aim at, then back to the first, which gets a second pane.
    await createWindowKeyboard(page);
    await waitForWindowCount(page, 2);
    await selectWindowKeyboard(page, 1);
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);

    const windowIds = await page.evaluate(() =>
      (window.app?.getSnapshot()?.context?.windows || [])
        .filter((w) => w.windowType === 'tab')
        .map((w) => w.id),
    );
    const sourceWindow = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    const targetWindow = windowIds.find((id) => id !== sourceWindow);
    const before = await panesByWindow();
    expect(before[sourceWindow]).toBe(2);
    expect(before[targetWindow]).toBe(1);

    const header = await secondPaneHeaderBox(page);
    const tabBox = await page.evaluate((id) => {
      const el = document.querySelector(`.tab-name[data-window-id="${id}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, targetWindow);

    await dragHeaderTo(page, header, tabBox.x, tabBox.y);

    // The tab under the pointer says it would take the pane: it is marked, and
    // the mark is visible — an outline it does not otherwise carry.
    await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`.tab-name[data-window-id="${id}"]`);
          if (!el || !el.classList.contains('is-pane-drop-target')) return false;
          const outline = getComputedStyle(el).outlineWidth;
          return parseFloat(outline) > 0;
        }, targetWindow),
      8000,
      'the target tab to be highlighted as the drop target',
    );
    // No new-tab placeholder while the pointer is on a tab.
    expect(await page.$('.tab-new-drop')).toBeNull();
    // The other tab is not marked.
    expect(
      await page.evaluate(
        (id) =>
          document
            .querySelector(`.tab-name[data-window-id="${id}"]`)
            .classList.contains('is-pane-drop-target'),
        sourceWindow,
      ),
    ).toBe(false);

    await page.mouse.up();

    await waitForCondition(
      page,
      async () => {
        const counts = await panesByWindow();
        return counts[targetWindow] === 2 && (counts[sourceWindow] || 0) === 1;
      },
      10000,
      async () => `the pane to move tabs (panes: ${JSON.stringify(await panesByWindow())})`,
    );
    // The highlight goes away with the drag.
    expect(await page.$('.tab-name.is-pane-drop-target')).toBeNull();
  }, 150000);

  // Dropped past the last tab, the pane becomes a tab of its own. The empty
  // space has nothing to highlight, so a dashed placeholder stands in for the
  // tab that would be created.
  test('drag a pane to the empty strip: a dashed "New Tab" appears, and the drop breaks the pane out', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);
    // The strip is measured below, so wait for it to exist. Waiting only for
    // the PANE count does not imply the tab strip has rendered — they are
    // different components off different parts of the model — and reading an
    // empty strip fails as `tabs[tabs.length - 1]` being undefined, which
    // reports as a TypeError about `getBoundingClientRect` rather than as
    // "the tab strip was not ready".
    await waitForWindowCount(page, 1);
    const sourceWindow = await page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect((await panesByWindow())[sourceWindow]).toBe(2);

    const header = await secondPaneHeaderBox(page);
    // Well past the last tab, still inside the strip's row.
    const empty = await page.evaluate(() => {
      const list = document.querySelector('.tab-list');
      const tabs = [...list.querySelectorAll('.tab-name[data-window-id]')];
      const last = tabs[tabs.length - 1].getBoundingClientRect();
      const strip = list.getBoundingClientRect();
      return { x: Math.min(last.right + 160, strip.right - 20), y: strip.top + strip.height / 2 };
    });

    await dragHeaderTo(page, header, empty.x, empty.y);

    // The placeholder is there, it says what it does, and it is drawn dashed
    // and big enough to read — not a zero-size node in the DOM.
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const el = document.querySelector('.tab-new-drop');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return (
            el.textContent.trim() === 'New Tab' &&
            r.width > 30 &&
            r.height > 8 &&
            cs.borderStyle === 'dashed' &&
            parseFloat(cs.borderWidth) > 0
          );
        }),
      8000,
      'the dashed New Tab placeholder to appear in the strip',
    );
    // Nothing on the strip is claiming the pane at the same time.
    expect(await page.$('.tab-name.is-pane-drop-target')).toBeNull();

    await page.mouse.up();

    await waitForWindowCount(page, 2);
    await waitForCondition(
      page,
      async () => {
        const counts = await panesByWindow();
        const ids = Object.keys(counts);
        return (
          ids.length === 2 && counts[sourceWindow] === 1 && ids.every((id) => counts[id] === 1)
        );
      },
      10000,
      async () =>
        `the pane to become its own tab (panes: ${JSON.stringify(await panesByWindow())})`,
    );
    expect(await page.$('.tab-new-drop')).toBeNull();
  }, 150000);
});
