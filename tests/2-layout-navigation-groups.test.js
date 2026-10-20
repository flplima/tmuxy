/**
 * Layout & Navigation E2E Tests (Pane Groups & Horizontal Navigation)
 */

const {
  createTestContext,
  delay,
  focusPage,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForTerminalText,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  openSidebarKeyboard,
  createWindowKeyboard,
  clickPaneGroupAdd,
  clickGroupTabAdd,
  getGroupTabCount,
  clickGroupTab,
  clickGroupTabClose,
  waitForGroupTabs,
  isHeaderGrouped,
  getGroupTabInfo,
  getThemeAccent,
  assertLayoutInvariants,
  waitForCondition,
  DELAYS,
} = require('./helpers/layout-helpers');

// ==================== Scenario 5: Pane Groups ====================

describe('Scenario 5: Pane Groups', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Header → add button → create group → switch tabs → identity verify → add 3rd → close tab → ungroup', async () => {
    if (ctx.skipIfNotReady()) return;
    const activePane = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.activePaneId || null);
    // A group switch is settled by a fixed wait here, deliberately: the
    // client's active pane is optimistic, tmux's own answer names the pane
    // of whatever window it considers current while a group swap is under
    // way, and a wait on either let the next group operation go out
    // mid-swap on CI (the third member then never took the keyboard).
    await ctx.setupPage();

    // Layout invariants on initial single pane
    await assertLayoutInvariants(ctx.page, { label: 'Scenario 5 initial' });

    // Step 1: Header element exists
    const header = await ctx.page.$('.pane-tab');
    expect(header).not.toBeNull();

    // Step 2: Menu button exists (pane group add is via ⋮ menu)
    const menuButton = await ctx.page.$('.pane-header-menu');
    expect(menuButton).not.toBeNull();

    // Step 3: Record original (ALPHA) pane ID and stamp its CONTENT with a
    // token — pane identity is verified below by what the user actually sees
    // rendered, not only by state-level ids (a swap that renders the wrong
    // pane's content under the right id would pass an id-only check).
    const alphaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(alphaPaneId).not.toBeNull();
    const ALPHA_TOKEN = `ALPHA_CONTENT_${Date.now()}`;
    await focusPage(ctx.page);
    await typeInTerminal(ctx.page, `echo ${ALPHA_TOKEN}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 4: Create group
    expect(await isHeaderGrouped(ctx.page)).toBe(false);
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    expect(await isHeaderGrouped(ctx.page)).toBe(true);
    let tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.length).toBe(2);
    expect(tabs.filter((t) => t.active).length).toBe(1);

    // The strip says WHICH member is showing by colour: the one in view wears
    // the theme's accent and the parked one does not. Both are listed, so the
    // colour is the only thing telling them apart — a group whose tabs all
    // read the same is a group you cannot navigate by eye.
    const accent = await getThemeAccent(ctx.page);
    expect(tabs.find((t) => t.active).color).toBe(accent);
    expect(tabs.filter((t) => !t.active).map((t) => t.color)).not.toContain(accent);

    // The header is SHARED between the members: an equal share each, with the
    // member's own ⋮ and ✕ at the right of its own share. One pair of buttons
    // for the whole strip belonged to whichever member happened to be showing,
    // and could never close a parked one.
    for (const tab of tabs) {
      expect(tab.controls).toEqual(['⋮', '✕']);
      expect(tab.controlsAfterTitle).toBe(true);
    }
    const widths = tabs.map((t) => t.width);
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(widths[0] * 0.25);
    // ...and the parked member's share is dimmed by its ground, so the two
    // read apart without reading them.
    expect(tabs.find((t) => t.active).background).not.toBe(tabs.find((t) => !t.active).background);

    // Step 4b: The group parks its members in hidden tmux windows, which take
    // window indices of their own. A tab opened now must still read ➋, by its
    // position in the strip — it shipped reading "5:", the tmux index.
    const groupWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId ?? null,
    );
    expect(groupWindowId).toMatch(/^@\d+$/);
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    const tabLabels = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('.tab-list .tab-name')].map((el) =>
          (el.querySelector('.tab-mark')?.textContent || '').trim(),
        ),
      );
    await waitForCondition(
      ctx.page,
      async () => {
        const labels = await tabLabels();
        return labels.length === 2 && labels[0] === '➊' && labels[1] === '➋';
      },
      10000,
      async () => `the tab strip to read ➊, ➋ (saw ${JSON.stringify(await tabLabels())})`,
    );
    // Back to the group's tab, by its stable id, for the rest of the scenario.
    await ctx.page.click(`.tab-list .tab-name[data-window-id="${groupWindowId}"]`);
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          (id) => window.app?.getSnapshot()?.context?.activeWindowId === id,
          groupWindowId,
        ),
      10000,
      'the group window to be back on screen',
    );
    await waitForGroupTabs(ctx.page, 2);
    // And close that tab the way the strip offers it — right-click → "Close
    // Tab" — so the rest of the scenario reads one window's group header. A
    // background tab keeps its panes mounted, and its lone header tab would
    // otherwise be counted among the group's.
    await ctx.page.click(
      `.tab-list .tab-name[data-window-id]:not([data-window-id="${groupWindowId}"])`,
      { button: 'right' },
    );
    await ctx.page.locator('[role="menuitem"]', { hasText: 'Close Tab' }).click({ timeout: 5000 });
    await waitForWindowCount(ctx.page, 1);

    // Step 5: Record the new (BETA) pane ID — it should be different from ALPHA
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate((alpha) => {
          const id = window.app?.getSnapshot()?.context?.activePaneId || null;
          return id !== null && id !== alpha;
        }, alphaPaneId),
      10000,
      'the new group member to be the active pane',
    );
    const betaPaneId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(betaPaneId).not.toBeNull();
    expect(betaPaneId).not.toBe(alphaPaneId);

    // Step 6: Switch to original pane tab, verify pane identity via ID
    const inactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, inactiveIdx);
    await waitForGroupTabs(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const id = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activePaneId || null,
        );
        return id === alphaPaneId;
      },
      10000,
      'group tab switch to ALPHA pane',
    );

    tabs = await getGroupTabInfo(ctx.page);
    expect(tabs.filter((t) => t.active).length).toBe(1);
    // ...and the accent moved with the switch, rather than staying on the tab
    // that used to be showing.
    expect(tabs.find((t) => t.active).color).toBe(accent);
    expect(tabs.filter((t) => !t.active).map((t) => t.color)).not.toContain(accent);

    const afterSwitchId = await ctx.page.evaluate(() => {
      return window.app?.getSnapshot()?.context?.activePaneId || null;
    });
    expect(afterSwitchId).toBe(alphaPaneId);
    // Content fingerprint: the VISIBLE pane must show ALPHA's scrollback.
    await waitForTerminalText(ctx.page, ALPHA_TOKEN);

    // Step 7: Switch back to BETA pane and verify identity
    const betaIdx = tabs.findIndex((t) => t.active); // currently on ALPHA's tab
    const otherIdx = betaIdx === 0 ? 1 : 0;
    await clickGroupTab(ctx.page, otherIdx);
    // Settled by a fixed wait, deliberately — see the note at `activePane`.
    await delay(DELAYS.SYNC);

    const afterSwitch2Id = await activePane();
    expect(afterSwitch2Id).toBe(betaPaneId);

    // Step 8: Verify tab highlight matches active pane
    const tabsAfterSwitch = await getGroupTabInfo(ctx.page);
    const selectedTab = tabsAfterSwitch.find((t) => t.active);
    expect(selectedTab).toBeDefined();
    expect(selectedTab.index).toBe(otherIdx);

    // Step 9: Add 3rd tab
    await clickGroupTabAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9a: Record GAMMA pane ID (the newly added 3rd tab, which is now active)
    await delay(DELAYS.SYNC);
    const gammaPaneId = await activePane();
    expect(gammaPaneId).not.toBeNull();
    expect(gammaPaneId).not.toBe(alphaPaneId);
    expect(gammaPaneId).not.toBe(betaPaneId);

    // Step 9b: Switch to first tab (ALPHA) with 3 tabs — this is the scenario
    // that triggers the bug where a pane escapes the group window when the
    // active tmux window is itself a group window.
    tabs = await getGroupTabInfo(ctx.page);
    const firstInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, firstInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9c: Switch to another inactive tab with 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const secondInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, secondInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 9d: Switch one more time — cycle through all 3 tabs
    tabs = await getGroupTabInfo(ctx.page);
    const thirdInactiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTab(ctx.page, thirdInactiveIdx);
    await delay(DELAYS.SYNC);
    await waitForGroupTabs(ctx.page, 3);
    expect(await getGroupTabCount(ctx.page)).toBe(3);

    // Step 10: Close a tab (last non-active one)
    await clickGroupTabClose(ctx.page, 2);
    await waitForGroupTabs(ctx.page, 2);
    expect(await getGroupTabCount(ctx.page)).toBe(2);

    // Step 11: Close remaining extra tab → revert to regular header
    // Close the non-active tab (find it dynamically since index may vary)
    tabs = await getGroupTabInfo(ctx.page);
    const nonActiveIdx = tabs.findIndex((t) => !t.active);
    await clickGroupTabClose(ctx.page, nonActiveIdx >= 0 ? nonActiveIdx : 1);
    await waitForCondition(
      ctx.page,
      async () => {
        return !(await isHeaderGrouped(ctx.page));
      },
      15000,
      'header to revert to ungrouped',
    );

    // Pane should still exist
    const finalHeader = await ctx.page.$('.pane-tab');
    expect(finalHeader).not.toBeNull();
  }, 180000);
});

// ====== Scenario 6h: nav left/right walks the group, the panes, then the dock ======

describe('Scenario 6h: Horizontal nav through a group, the panes and the dock', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** Where the keyboard is, and which member of the group is showing. */
  const where = (page) =>
    page.evaluate(() => {
      const c = window.app.getSnapshot().context;
      const active = c.panes.find((p) => p.tmuxId === c.activePaneId);
      const group = Object.values(c.paneGroups)[0];
      const shown = group?.paneIds.find(
        (id) => c.panes.find((p) => p.tmuxId === id)?.windowId === c.activeWindowId,
      );
      return {
        active: c.activePaneId,
        activeX: active?.x ?? null,
        members: group?.paneIds ?? [],
        shown: shown ?? null,
        dockFocused: c.rightSidebarFocused,
      };
    });

  const until = (label, check) =>
    waitForCondition(
      ctx.page,
      async () => check(await where(ctx.page)),
      10000,
      // Where the keyboard was when the wait gave up is the diagnosis.
      async () => `${label}\nlast seen: ${JSON.stringify(await where(ctx.page))}`,
    );

  test('nav right shows the next group member, then the pane on the right, then the dock; nav left walks back [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Two panes side by side; the left one becomes a group of two.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    await navigatePaneKeyboard(ctx.page, 'left');
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    await until('the group to hold the keyboard', (w) => w.members.includes(w.active));
    const [first, last] = (await where(ctx.page)).members;

    // Start on the group's first member, in the left slot.
    if ((await where(ctx.page)).shown !== first) {
      await navigatePaneKeyboard(ctx.page, 'left');
      await until('nav left to show the first member', (w) => w.shown === first);
    }
    expect((await where(ctx.page)).activeX).toBe(0);

    // nav left from the first member of the leftmost pane: no member before it,
    // no pane to its left, no left sidebar — nothing moves.
    await navigatePaneKeyboard(ctx.page, 'left');
    await delay(DELAYS.SYNC);
    expect(await where(ctx.page)).toEqual(
      expect.objectContaining({ active: first, shown: first, activeX: 0 }),
    );

    // Ctrl+l shows the next member, in the same slot.
    await navigatePaneKeyboard(ctx.page, 'right');
    await until('nav right to show the next member', (w) => w.shown === last && w.active === last);
    expect((await where(ctx.page)).activeX).toBe(0);

    // nav right from the last member moves on to the pane on the right, and the
    // group keeps showing the member it was on — leaving the group is not
    // stepping it. Both are waited for together: the keyboard lands on the
    // right pane before the group's swap has settled, so a wait on the
    // keyboard alone let the assertion read the group mid-swap, with no
    // member in the visible window at all (~1 run in 3).
    await navigatePaneKeyboard(ctx.page, 'right');
    await until(
      'nav right from the last member to reach the right pane, group still on the last member',
      (w) => w.activeX > 0 && w.shown === last,
    );

    // nav left comes back into the group as it is showing, without stepping it.
    await navigatePaneKeyboard(ctx.page, 'left');
    await until(
      'nav left to return to the group, still on the last member',
      (w) => w.active === last && w.shown === last,
    );

    // With the dock open, nav right from the rightmost pane goes into it.
    await navigatePaneKeyboard(ctx.page, 'right');
    await until('nav right to reach the right pane again', (w) => w.activeX > 0);
    await openSidebarKeyboard(ctx.page, 'right');
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 20000 });
    // Opening the dock hands it the keyboard once its pane exists, a beat
    // after the column draws; a nav pressed before then goes to the grid.
    await until('the opened dock to take the keyboard', (w) => w.dockFocused === true);
    await navigatePaneKeyboard(ctx.page, 'left'); // the dock hands the keyboard back
    await until('the dock to hand the keyboard back', (w) => w.dockFocused === false);
    await navigatePaneKeyboard(ctx.page, 'right');
    await until(
      'nav right from the rightmost pane to focus the dock',
      (w) => w.dockFocused === true,
    );

    await ctx.page.click('button[aria-label="Toggle terminal sidebar"]');
  }, 180000);
});
