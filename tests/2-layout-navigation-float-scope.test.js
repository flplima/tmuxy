/**
 * Layout & Navigation E2E Tests (Float Tab Scope, Context Menu & Cursor Motion)
 */

const {
  createTestContext,
  delay,
  runCommand,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  TMUXY_CLI,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  createWindowKeyboard,
  clickPaneGroupAdd,
  clickGroupTab,
  waitForGroupTabs,
  waitForCondition,
  verifyFloatVisible,
  waitForFloatModal,
  focusedFloatPaneId,
  sampleCursorGlide,
  glidePositions,
} = require('./helpers/layout-helpers');

// ============ Scenario 6f: A float belongs to the tab it was opened over ============

describe('Scenario 6f: Float Tab Scope', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** The tab buttons in strip order. */
  async function tabButtons(page) {
    return page.$$('.tab-name:not(.tab-add)');
  }

  /** Click whichever tab button is not the active one. */
  /** Click the inactive tab, and resolve once the app is on its window. */
  async function clickOtherTab(page) {
    const activeWindow = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);
    const from = await activeWindow();
    for (const tab of await tabButtons(page)) {
      const active = await tab.evaluate((el) => el.classList.contains('tab-name-active'));
      if (!active) {
        await tab.click();
        await waitForCondition(
          page,
          async () => (await activeWindow()) !== from,
          8000,
          'the tab click to switch the active window',
        );
        return;
      }
    }
    throw new Error('no inactive tab button to click');
  }

  test('Float over tab 1 → backdrop covers the tab content only → other tab is clear → back again [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A second tab to switch to. It opens active, so click back to the first
    // one: the float has to be opened over tab 1.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2, 10000);
    await clickOtherTab(ctx.page);
    const homeWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );

    // Step 1: open the float the way a user does
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);
    // The float is opened and focused by one script; it is up when the app
    // holds it as the focused float.
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => !!window.app?.getSnapshot()?.context?.focusedFloatPaneId),
      10000,
      'the new float to take focus',
    );

    const floatPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(floatPaneId).toMatch(/^%\d+$/);

    // Step 2: the float is tagged with the tab it was opened over, and the
    // backdrop dims that tab's content and nothing else — the tab strip above
    // it stays uncovered, so the user can still switch tabs.
    const measureScope = () => {
      const backdrop = document.querySelector('.modal-backdrop');
      const container = document.querySelector('.pane-container');
      const strip = document.querySelector('.tab-list');
      if (!backdrop || !container || !strip) return null;
      const b = backdrop.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      return {
        // The raw boxes travel with the deltas: a failure that says only
        // "dTop 24" cannot tell a backdrop resolving against the wrong
        // ancestor from a container that moved under it.
        boxes: {
          backdrop: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
          container: { top: c.top, bottom: c.bottom, left: c.left, right: c.right },
          strip: { top: s.top, bottom: s.bottom },
          backdropParent: backdrop.parentElement?.className ?? null,
          backdropOffsetParent: backdrop.offsetParent?.className ?? null,
          // The overlay is `position:absolute; inset:0`, so its box IS its
          // containing block's padding box. When the backdrop comes out the
          // right SIZE but in the wrong PLACE, the question is which ancestor
          // it resolved against — so walk up and record each one's box and the
          // properties that can make it a containing block.
          ancestors: (() => {
            const chain = [];
            let el = backdrop.parentElement;
            while (el && chain.length < 6) {
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              chain.push({
                className: el.className,
                position: cs.position,
                transform: cs.transform === 'none' ? null : cs.transform,
                zoom: cs.zoom,
                padding: cs.padding,
                overflow: cs.overflow,
                // An absolutely positioned child of a SCROLLED container is
                // drawn offset by that scroll, which is the one way a child at
                // `inset: 0` can sit outside its containing block's box.
                scroll: { top: el.scrollTop, left: el.scrollLeft },
                scrollSize: { width: el.scrollWidth, height: el.scrollHeight },
                clientSize: { width: el.clientWidth, height: el.clientHeight },
                box: { top: r.top, left: r.left, width: r.width, height: r.height },
              });
              el = el.parentElement;
            }
            return chain;
          })(),
        },
        dTop: Math.abs(b.top - c.top),
        dBottom: Math.abs(b.bottom - c.bottom),
        dLeft: Math.abs(b.left - c.left),
        dRight: Math.abs(b.right - c.right),
        stripAbove: s.bottom <= b.top + 1,
        parent:
          window.app?.getSnapshot()?.context?.floatPanes?.[
            window.app?.getSnapshot()?.context?.focusedFloatPaneId
          ]?.parentWindowId,
      };
    };
    // The float opening reflows the grid, so the backdrop and the container
    // reach their final boxes a frame or two apart. Wait for them to agree
    // rather than measuring into the middle of that.
    let scope = null;
    const aligned = (s) => s && s.dTop <= 1 && s.dBottom <= 1 && s.dLeft <= 1 && s.dRight <= 1;
    await waitForCondition(
      ctx.page,
      async () => {
        scope = await ctx.page.evaluate(measureScope);
        return aligned(scope);
      },
      5000,
      // One message carrying the boxes: four separate `expect`s reported only
      // the first delta and stopped, and "dTop 24" cannot tell a backdrop
      // resolving against the wrong ancestor from a container that moved
      // under it.
      () => {
        const misaligned = ['dTop', 'dBottom', 'dLeft', 'dRight'].filter(
          (k) => scope && scope[k] > 1,
        );
        return (
          `the float backdrop to cover the tab content: ${misaligned.join(', ')} off by more than 1px\n` +
          JSON.stringify(scope, null, 2)
        );
      },
    );
    expect(scope.stripAbove).toBe(true);
    expect(scope.parent).toBe(homeWindowId);

    // Step 3: the other tab shows no float at all
    await clickOtherTab(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });
    expect(
      await ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.focusedFloatPaneId),
    ).toBeNull();
    // And that tab's own pane takes input, rather than the hidden float.
    const TOKEN = 'OTHER_TAB_' + Date.now();
    await runCommand(ctx.page, `echo ${TOKEN}`, TOKEN);

    // Step 4: back on its own tab, the same float is up again — one of it, not
    // a second one.
    await clickOtherTab(ctx.page);
    await waitForFloatModal(ctx.page, 10000);
    await verifyFloatVisible(ctx.page);
    const backAgain = await ctx.page.evaluate(() => ({
      count: document.querySelectorAll('.modal-overlay').length,
      focused: window.app?.getSnapshot()?.context?.focusedFloatPaneId,
      active: window.app?.getSnapshot()?.context?.activeWindowId,
    }));
    expect(backAgain.count).toBe(1);
    expect(backAgain.focused).toBe(floatPaneId);
    expect(backAgain.active).toBe(homeWindowId);

    // Leave the session without the float.
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 10000,
      polling: 100,
    });
  }, 180000);
});

// ====== Scenario 6j: right-click anywhere on a pane header opens that pane's menu ======

describe('Scenario 6j: Pane header context menu', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /**
   * Right-click `selector` with the real right button. Playwright's own click
   * waits for the element to be visible and stable, and names whatever covers
   * it if something does.
   */
  const rightClick = (selector) =>
    ctx.page.locator(selector).first().click({ button: 'right', timeout: 5000 });

  /** The pane menu is on screen: in the DOM is not enough. */
  const menuVisible = (after) =>
    waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(() => {
          const r = document
            .querySelector('[role="menu"][aria-label="Pane"]')
            ?.getBoundingClientRect();
          return !!r && r.width > 40 && r.height > 40 && r.top >= 0 && r.bottom <= innerHeight;
        }),
      5000,
      async () =>
        `the pane menu to be on screen after right-clicking ${after}\n${await ctx.page.evaluate(
          () => {
            const m = document.querySelector('[role="menu"][aria-label="Pane"]');
            const r = m?.getBoundingClientRect();
            return JSON.stringify({
              menu: m
                ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
                : null,
              viewport: [innerWidth, innerHeight],
            });
          },
        )}`,
    );

  const chooseItem = async (label) => {
    await ctx.page
      .locator('[role="menu"][aria-label="Pane"] [role="menuitem"]', { hasText: label })
      .first()
      .click();
    await waitForCondition(
      ctx.page,
      async () => (await ctx.page.$('[role="menu"][aria-label="Pane"]')) === null,
      5000,
      'the pane menu to close',
    );
  };

  const marked = (paneId) =>
    ctx.session.runCommand(`display-message -p -t ${paneId} '#{pane_marked}'`).trim() === '1';

  test('the ⋮, the MARKED badge, a hidden group member and a float header each open the menu for their pane [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    const paneA = await ctx.page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const header = `.pane-layout-item[data-pane-id="${paneA}"] .pane-header`;

    // The ⋮ of a single pane sits outside its tab: right-clicking it is the
    // header of that pane, and an action from the menu acts on it.
    await rightClick(`${header} .pane-header-menu`);
    await menuVisible(`${header} .pane-header-menu`);
    await chooseItem('Mark Pane');
    await waitForCondition(ctx.page, async () => marked(paneA), 5000, `${paneA} to be marked`);
    await ctx.page.waitForSelector(`${header} [data-testid="pane-header-mark"]`, {
      state: 'visible',
    });

    // The MARKED badge is outside the tab too.
    await rightClick(`${header} [data-testid="pane-header-mark"]`);
    await menuVisible(`${header} [data-testid="pane-header-mark"]`);
    await chooseItem('Unmark Pane');
    await waitForCondition(ctx.page, async () => !marked(paneA), 5000, `${paneA} to be unmarked`);

    // A group's header: the share of the member that is NOT showing names
    // that member, not the one on screen.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    const hidden = await ctx.page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.pane-tabs-group .pane-tab')];
      return tabs.find((t) => !t.classList.contains('pane-tab-selected'))?.dataset.paneTab;
    });
    expect(hidden).toMatch(/^%\d+$/);
    await rightClick(`.pane-tab[data-pane-tab="${hidden}"]`);
    await menuVisible(`.pane-tab[data-pane-tab="${hidden}"]`);
    await chooseItem('Mark Pane');
    await waitForCondition(ctx.page, async () => marked(hidden), 5000, `${hidden} to be marked`);

    // A float's header is the same header.
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);
    await waitForFloatModal(ctx.page, 20000);
    await rightClick('.float-container .pane-header');
    await menuVisible('.float-container .pane-header');
    await ctx.page.keyboard.press('Escape');
  }, 120000);
});

// ====== Scenario 6i: the cursor jumps, not glides, when the picture under it changes ======

describe('Scenario 6i: Cursor motion across tabs and group members', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /**
   * The motion a trigger produced, as the assertion wants it: how many places
   * the overlay was seen at, and whether it ended somewhere else at all — a
   * "jump" that never moved would pass a distinct-positions check vacuously.
   */
  const motion = async (trigger) => {
    await cursorStill(ctx.page);
    const glide = await sampleCursorGlide(ctx.page, trigger);
    // A glide moves the overlay on many frames in a row; a jump moves it on
    // one and holds. A switch may jump more than once (the new pane's content
    // can land a beat later), so the count is the longest run, not the total.
    let run = 0;
    let longestRun = 0;
    for (let i = 1; i < glide.frames.length; i++) {
      run = String(glide.frames[i]) === String(glide.frames[i - 1]) ? 0 : run + 1;
      longestRun = Math.max(longestRun, run);
    }
    return {
      moved: String(glide.settled) !== String(glide.frames[0]),
      longestRun,
      detail: JSON.stringify(glidePositions(glide)),
    };
  };

  /** Resolves once the overlay has not moved for a few frames, so a sample starts from rest. */
  const cursorStill = (page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const shape = document.querySelector(
            '[data-testid="smooth-cursor"] .smooth-cursor-shape',
          );
          let last = null;
          let still = 0;
          const tick = () => {
            const now = shape?.style.clipPath ?? '';
            still = now === last ? still + 1 : 0;
            last = now;
            if (still >= 10) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );

  test('moving between panes glides; switching group member or tab draws the cursor in place [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Two panes side by side: moving the keyboard between them is a move
    // within one picture, and glides.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);
    const between = await motion(() => navigatePaneKeyboard(ctx.page, 'left'));
    expect(between.moved).toBe(true);
    expect(between.longestRun >= 3 ? 'glided' : between.detail).toBe('glided');

    // A group in the left slot whose two members hold their cursors on
    // different rows, so a switch has somewhere else to put it.
    await clickPaneGroupAdd(ctx.page);
    await waitForGroupTabs(ctx.page, 2);
    // The awaited text is in the output only, not in what is typed.
    await runCommand(ctx.page, 'for i in 1 2 3 4 5 6; do echo row$i; done', 'row6');
    const member = await motion(() => clickGroupTab(ctx.page, 0));
    expect(member.moved).toBe(true);
    expect(member.longestRun <= 2 ? 'drawn in place' : member.detail).toBe('drawn in place');

    // Another tab, then back: the whole picture changes both times. The new
    // tab's cursor sits after its first prompt, top left — exactly where this
    // member's is until it prints something, which would leave nothing to see.
    await runCommand(ctx.page, 'for i in 1 2 3; do echo back$i; done', 'back3');
    const firstTab = await ctx.page.evaluate(() => window.app.getSnapshot().context.activeWindowId);
    await createWindowKeyboard(ctx.page);
    const tab = await motion(() => ctx.page.click(`.tab-name[data-window-id="${firstTab}"]`));
    expect(tab.moved).toBe(true);
    expect(tab.longestRun <= 2 ? 'drawn in place' : tab.detail).toBe('drawn in place');
  }, 120000);
});
