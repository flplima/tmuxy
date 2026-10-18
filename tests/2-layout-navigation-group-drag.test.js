/**
 * Layout & Navigation E2E Tests (Pane Group Drag, Status Bar & Tab Rename Paste)
 */

const {
  createTestContext,
  focusPage,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  splitPaneKeyboard,
  createWindowKeyboard,
  renameWindowKeyboard,
  clickPaneGroupAdd,
  waitForGroupTabs,
  assertLayoutInvariants,
  waitForCondition,
  pasteText,
} = require('./helpers/layout-helpers');

// ==================== Scenario 5b: Reorder a group, drag panes in and out ====================

describe('Scenario 5b: Pane group order and membership by drag', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** The group header's tabs as the user reads them: left to right, on screen. */
  const groupTabs = () =>
    ctx.page.evaluate(() =>
      [...document.querySelectorAll('.pane-tabs-group .pane-tab')]
        .map((t) => ({ id: t.dataset.paneTab, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 20 && r.height > 5 && r.bottom > 0 && r.top < innerHeight)
        .sort((a, b) => a.r.left - b.r.left)
        .map(({ id }) => id),
    );

  const centre = (selector) =>
    ctx.page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.toJSON() };
    }, selector);

  /** The panes laid out in the tab on screen. */
  const visiblePanes = () =>
    ctx.page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      return c.panes.filter((p) => p.windowId === c.activeWindowId).map((p) => p.tmuxId);
    });

  /** What the header reads, what the client holds and what tmux holds. */
  const orderReport = async () =>
    `it reads ${await groupTabs()}\nclient: ${await ctx.page.evaluate(() =>
      JSON.stringify(
        window.app
          .getSnapshot()
          .context.panes.map((p) => [p.tmuxId, p.windowId, p.groupId, p.groupPos]),
      ),
    )}\ntmux: ${ctx.session.runCommand(
      "list-panes -a -F '#{pane_id} #{window_id} #{@tmuxy-group-id} #{@tmuxy-group-pos}'",
    )}`;

  const option = (paneId, name) =>
    ctx.session.runCommand(`show-options -pqv -t ${paneId} ${name}`).trim();

  /**
   * Press at `from`, cross the drag threshold, then go to each point in turn,
   * resting at each — except a `passing` point, which the pointer only moves
   * through on its way to the next, as a hand does.
   */
  const dragThrough = async (from, points) => {
    /** The drag has seen the pointer at (x, y), or has started when no point is given. */
    const dragAt = (x, y) =>
      waitForCondition(
        ctx.page,
        () =>
          ctx.page.evaluate(
            ([px, py]) => {
              const d = window.app.getSnapshot().context.drag;
              if (!d) return false;
              return (
                px === null || (Math.abs(d.currentX - px) < 1 && Math.abs(d.currentY - py) < 1)
              );
            },
            [x, y],
          ),
        5000,
        x === null ? 'the drag to start' : `the drag to reach (${x}, ${y})`,
      );
    await ctx.page.mouse.move(from.x, from.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(from.x + 12, from.y + 1);
    await dragAt(null, null);
    for (const p of points) {
      await ctx.page.mouse.move(p.x, p.y);
      if (!p.passing) await dragAt(p.x, p.y);
    }
  };

  test('drag a member along the header to reorder it, drop a pane on the header to join, drag a parked member out [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // Two panes, one above the other; the top one becomes a group of three.
    await splitPaneKeyboard(page, 'vertical');
    await waitForPaneCount(page, 2);
    const [top, other] = await page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      return c.panes
        .filter((p) => p.windowId === c.activeWindowId)
        .sort((a, b) => a.y - b.y)
        .map((p) => p.tmuxId);
    });
    await page.click(`.pane-layout-item[data-pane-id="${top}"] .pane-header`);
    await waitForCondition(
      page,
      () => page.evaluate((id) => window.app.getSnapshot().context.activePaneId === id, top),
      5000,
      `${top} to be the active pane`,
    );
    await clickPaneGroupAdd(page);
    await clickPaneGroupAdd(page);
    await waitForGroupTabs(page, 3);
    const members = await groupTabs();
    expect(members).toHaveLength(3);
    const byNumber = [...members].sort((a, b) => +a.slice(1) - +b.slice(1));
    expect(members).toEqual(byNumber);

    // 1. The last member, dragged onto the first share, takes the first place.
    const last = await centre(`.pane-tab[data-pane-tab="${members[2]}"]`);
    const first = await centre(`.pane-tab[data-pane-tab="${members[0]}"]`);
    await dragThrough(last, [{ x: first.r.left + 10, y: first.y }]);
    await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`.pane-tab[data-pane-tab="${id}"]`);
          return (
            el?.classList.contains('pane-tab-drop-onto') &&
            getComputedStyle(el).boxShadow !== 'none'
          );
        }, members[0]),
      5000,
      'the first share to be marked as where the member would go',
    );
    await page.mouse.up();
    const reordered = [members[2], members[0], members[1]];
    await waitForCondition(
      page,
      async () => JSON.stringify(await groupTabs()) === JSON.stringify(reordered),
      10000,
      async () => `the header to read ${reordered} (${await orderReport()})`,
    );
    // The header shows the new order at once (the client predicts it); tmux
    // has it when the move has run.
    await waitForCondition(
      page,
      async () => option(members[2], '@tmuxy-group-pos') === '0',
      10000,
      async () => `tmux to put ${members[2]} first (${await orderReport()})`,
    );
    expect(await page.$('.pane-tab-drop-onto')).toBeNull();

    // 2. The pane below, dropped on the left edge of the group's header, joins
    //    the group first in line — its path up crosses the group's own pane,
    //    which must not swap with it on the way.
    const otherHeader = await centre(`.pane-layout-item[data-pane-id="${other}"] .pane-header`);
    const firstShare = await centre(`.pane-tab[data-pane-tab="${reordered[0]}"]`);
    await dragThrough(otherHeader, [
      { x: firstShare.r.left + 4, y: firstShare.y + 60, passing: true },
      { x: firstShare.r.left + 4, y: firstShare.y },
    ]);
    await waitForCondition(
      page,
      () =>
        page.evaluate(
          (id) =>
            !!document
              .querySelector(`.pane-tab[data-pane-tab="${id}"]`)
              ?.classList.contains('pane-tab-drop-before'),
          reordered[0],
        ),
      5000,
      'the gap before the first member to be marked',
    );
    await page.mouse.up();
    await waitForCondition(
      page,
      async () => (await groupTabs()).length === 4 && (await visiblePanes()).length === 1,
      15000,
      async () =>
        `${other} to join the group (header ${await groupTabs()}, panes ${await visiblePanes()})`,
    );
    // The new order lands a beat after the membership: the positions are
    // re-read when tmux reports the group's revision changed.
    const joined = [other, ...reordered];
    await waitForCondition(
      page,
      async () => JSON.stringify(await groupTabs()) === JSON.stringify(joined),
      10000,
      async () => `the header to read ${joined} (${await orderReport()})`,
    );
    expect(option(other, '@tmuxy-group-id')).toBe(option(reordered[0], '@tmuxy-group-id'));

    // 3. A parked member, dragged by its tab into the lower part of the pane,
    //    leaves the group and is split in below it.
    const parked = await page.evaluate(
      () =>
        [...document.querySelectorAll('.pane-tabs-group .pane-tab')].find(
          (t) => !t.classList.contains('pane-tab-selected'),
        ).dataset.paneTab,
    );
    const shown = (await visiblePanes())[0];
    const parkedTab = await centre(`.pane-tab[data-pane-tab="${parked}"]`);
    const body = await centre(`.pane-layout-item[data-pane-id="${shown}"]`);
    await dragThrough(parkedTab, [{ x: body.x, y: body.r.bottom - 20 }]);
    await page.mouse.up();
    await waitForCondition(
      page,
      async () => (await groupTabs()).length === 3 && (await visiblePanes()).length === 2,
      15000,
      async () =>
        `${parked} to leave the group (header ${await groupTabs()}, panes ${await visiblePanes()})`,
    );
    expect(option(parked, '@tmuxy-group-id')).toBe('');
    // On screen, under the group's pane.
    const leftBox = await centre(`.pane-layout-item[data-pane-id="${parked}"]`);
    const groupBox = await centre(`.pane-layout-item[data-pane-id="${shown}"]`);
    expect(leftBox.r.height).toBeGreaterThan(40);
    expect(leftBox.r.top).toBeGreaterThan(groupBox.r.top);
    await assertLayoutInvariants(page);
  }, 180000);
});

// ==================== Scenario 11: Status Bar ====================

describe('Scenario 11: Status Bar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Bar visible → tab → session name → 2 windows → active distinct → click tab → rename → close via context menu', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Status bar visible
    const barInfo = await ctx.page.evaluate(() => {
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      if (!bar) return null;
      return {
        hasContent: bar.textContent.trim().length > 0,
        isVisible: bar.offsetParent !== null || bar.getBoundingClientRect().height > 0,
      };
    });
    expect(barInfo).not.toBeNull();
    expect(barInfo.hasContent).toBe(true);
    expect(barInfo.isVisible).toBe(true);

    // Step 2: Window tab present (the strip redraws as the config's
    // move-window lands, so it is waited for, not read once).
    const tab = await ctx.page.waitForSelector('.tab-name', { timeout: 5000 }).catch(() => null);
    expect(tab).not.toBeNull();

    // Step 3: Session name visible
    const barText = await ctx.page.evaluate(() => {
      const bar =
        document.querySelector('.status-bar') || document.querySelector('.tmux-status-bar');
      return bar ? bar.textContent : '';
    });
    expect(barText).toContain(ctx.session.name);

    // Step 4: Create second window - 2 tabs
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    expect(await ctx.session.getWindowCount()).toBe(2);

    // Step 5: Active tab distinct styling
    const activeTab = await ctx.page.$('.tab-name-active');
    expect(activeTab).not.toBeNull();

    // Step 6: Click inactive tab to switch
    await waitForWindowCount(ctx.page, 2, 10000);
    const allTabs = await ctx.page.$$('.tab-name:not(.tab-add)');
    expect(allTabs.length).toBe(2);
    let inactiveTab = null;
    for (const t of allTabs) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        inactiveTab = t;
        break;
      }
    }
    expect(inactiveTab).not.toBeNull();
    await inactiveTab.click();
    await waitForCondition(
      ctx.page,
      () => inactiveTab.evaluate((el) => el.classList.contains('tab-name-active')),
      8000,
      'the clicked tab to become the active one',
    );

    // Step 7: Rename window
    await renameWindowKeyboard(ctx.page, 'RENAMED_WINDOW');
    const stripText = () =>
      ctx.page.evaluate(() => {
        const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
        return Array.from(tabs)
          .map((t) => t.textContent)
          .join(' ');
      });
    await waitForCondition(
      ctx.page,
      async () => (await stripText()).includes('RENAMED_WINDOW'),
      8000,
      'the strip to show the new name',
    );
    const tabText = await ctx.page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-name:not(.tab-add)');
      return Array.from(tabs)
        .map((t) => t.textContent)
        .join(' ');
    });
    expect(tabText).toContain('RENAMED_WINDOW');

    // Step 8: Close a tab the way the strip offers it — right-click the
    // inactive tab → "Close Tab". Tabs carry no ✕ of their own: a row of
    // buttons each with a target you can hit by accident is a row you cannot
    // click confidently.
    const tabsForClose = await ctx.page.$$('.tab-name:not(.tab-add)');
    let tabToClose = null;
    for (const t of tabsForClose) {
      const isActive = await t.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!isActive) {
        tabToClose = t;
        break;
      }
    }
    expect(tabToClose).not.toBeNull();
    await tabToClose.click({ button: 'right' });
    await ctx.page.waitForSelector('[role="menu"]', { timeout: 5000 });
    const closeItem = await ctx.page.evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return items.find((el) => (el.textContent || '').startsWith('Close Tab')) ?? null;
    });
    expect(await closeItem.evaluate((el) => el !== null)).toBe(true);
    await closeItem.asElement().click();
    await waitForWindowCount(ctx.page, 1);
    expect(await ctx.session.getWindowCount()).toBe(1);
  }, 180000);
});

describe('Scenario 11b: Pasting into a tab rename field', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  // The clipboard went to the pane: the window-level paste listener took
  // every paste, the rename field included, and the shell got the new name.
  test('right-click → Rename Tab → paste stays in the field, the pane receives nothing', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The strip draws its tab from the first state; on a slow runner that
    // can land after the page is otherwise ready.
    const tab = await ctx.page.waitForSelector('.tab-name:not(.tab-add)', { timeout: 10000 });
    await tab.click({ button: 'right' });
    await ctx.page.waitForSelector('[role="menu"]', { timeout: 5000 });
    const renameItem = await ctx.page.evaluateHandle(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
          (el.textContent || '').startsWith('Rename Tab'),
        ) ?? null,
    );
    expect(await renameItem.evaluate((el) => el !== null)).toBe(true);
    await renameItem.asElement().click();
    await ctx.page.waitForSelector('[data-testid="inline-rename"]', { timeout: 5000 });
    expect(
      await ctx.page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') === 'inline-rename',
      ),
    ).toBe(true);

    // The paste is the field's: the app does not take it, and the field keeps
    // the focus to receive it.
    const TOKEN = `PASTED_NAME_${Date.now()}`;
    expect(await pasteText(ctx.page, TOKEN)).toBe(false);
    expect(
      await ctx.page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') === 'inline-rename',
      ),
    ).toBe(true);

    // Back to the shell: the next command runs on a line the token never reached.
    await ctx.page.keyboard.press('Escape');
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(() => document.querySelector('[data-testid="inline-rename"]') === null),
      5000,
      'the rename field to close',
    );
    await focusPage(ctx.page);
    const DONE = `DONE_${Date.now()}`;
    await typeInTerminal(ctx.page, `echo ${DONE}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, DONE);
    const screen = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"]'))
        .map((el) => el.textContent || '')
        .join('\n'),
    );
    expect(screen).not.toContain(TOKEN);
  }, 60000);
});
