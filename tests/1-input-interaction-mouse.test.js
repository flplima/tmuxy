/**
 * Input & Interaction E2E Tests (Mouse Click, Scroll & Cell Grid)
 */

const {
  afterFrames,
  createTestContext,
  delay,
  focusPage,
  waitForTerminalText,
  waitForShellPrompt,
  runCommand,
  typeInTerminal,
  pressEnter,
  openSidebarKeyboard,
  DELAYS,
  assertContentMatch,
  getCopyModeState,
  wheelIntoScrollView,
  waitForCondition,
  waitForCopyMode,
  enterCopyModeAndWait,
  startMouseCapture,
  readMouseEvents,
  stopMouseCapture,
  ensureMouseCaptureStopped,
} = require('./helpers');

// ==================== Mouse Cell Helpers ====================

/**
 * The cell grid of a pane as the user sees it: the box the cells start in
 * and the size of one cell, read from the rendered lines rather than from the
 * app's idea of the grid — the dock draws its cells smaller than the panes.
 */
async function gridOf(page, rootSelector) {
  const grid = await page.evaluate((sel) => {
    const root = [...document.querySelectorAll(sel)].find(
      (el) => el.getBoundingClientRect().width > 0 && el.querySelector('.terminal-line'),
    );
    if (!root) return null;
    const box = root.querySelector('.pane-scroll-container').getBoundingClientRect();
    const line = root.querySelector('.terminal-line');
    return {
      x: box.x,
      y: box.y,
      cellW: parseFloat(getComputedStyle(line).getPropertyValue('--cell-w')),
      cellH: line.getBoundingClientRect().height,
    };
  }, rootSelector);
  expect(grid).not.toBeNull();
  return grid;
}

/**
 * Click `frac` of the way across cell (col, row), both 0-based, and return the
 * press tmux delivered for it.
 */
async function clickCell(page, grid, col, row, frac = 0.5) {
  const before = (await readMouseEvents(0, 200)).filter((e) => e.type === 'press').length;
  await page.mouse.click(grid.x + (col + frac) * grid.cellW, grid.y + (row + 0.5) * grid.cellH);
  const start = Date.now();
  let presses = [];
  while (Date.now() - start < 5000) {
    presses = (await readMouseEvents(0, 200)).filter((e) => e.type === 'press');
    if (presses.length > before) break;
    await delay(DELAYS.SHORT);
  }
  expect(presses.length).toBeGreaterThan(before);
  return presses[presses.length - 1];
}

// ==================== Scenario 7: Mouse Click & Scroll ====================

describe('Scenario 7: Mouse Click & Scroll', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Click focus → wheel opens the scroll view (no copy mode) → text selects natively → typing closes it → prefix [ still gives copy mode', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await assertContentMatch(ctx.page, 'Scenario 7 setup');

    // Step 1: Click in terminal area doesn't lose focus
    await focusPage(ctx.page);
    const terminal = await ctx.page.$('[role="log"]');
    let box = await terminal.boundingBox();
    await ctx.page.mouse.click(box.x + 50, box.y + 50);
    await ctx.page.mouse.click(box.x + 100, box.y + 100);
    // runCommand types only once the app holds the keyboard.
    await runCommand(ctx.page, 'echo click_test', 'click_test');
    await runCommand(ctx.page, 'seq 1 100', '100');

    // Step 2: the wheel opens the native-like scroll view — scrollback to read
    // and select, with no cursor and nothing said to tmux. A wheel gesture
    // handing the pane a cursor and vi keys is the bug this replaced.
    await ctx.page.mouse.move(box.x + 100, box.y + box.height / 2);
    const scrolled = await wheelIntoScrollView(ctx.page);
    expect(scrolled.mode).toBe('scroll');

    // The view moves a row at a time, like copy mode and like a full-screen
    // application: the container never rests part-way through a row, so the
    // top row is never drawn half on screen.
    const rowAlignment = async () =>
      ctx.page.evaluate(() => {
        const el = document.querySelector('.pane-scroll-container');
        const rowHeight = window.app.getSnapshot().context.charHeight;
        return { scrollTop: el.scrollTop, rowHeight, offset: el.scrollTop % rowHeight };
      });
    let aligned = await rowAlignment();
    expect(aligned.rowHeight).toBeGreaterThan(0);
    expect(aligned.scrollTop).toBeGreaterThan(0);
    expect(aligned.offset).toBeCloseTo(0, 5);

    // And a wheel tick that is not a whole number of rows still lands on one.
    const beforeTick = aligned.scrollTop;
    await ctx.page.mouse.wheel(0, -Math.round(aligned.rowHeight * 1.5));
    await waitForCondition(
      ctx.page,
      async () => (await rowAlignment()).scrollTop !== beforeTick,
      5000,
      'the part-row wheel tick to move the view',
    );
    aligned = await rowAlignment();
    expect(aligned.offset).toBeCloseTo(0, 5);

    // Step 2b: keep wheeling, without a pause, all the way to the top. The
    // rows drawn there must be the OLDEST history, loaded by the view's first
    // fetch: a user who grabs the trackpad and goes used to see only the band
    // that had been on screen, with blanks above it, because the fetch asked
    // for the visible rows alone and the follow-up chunks were suppressed
    // while it was in flight.
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        if (cs?.mode === 'scroll' && cs.scrollTop === 0 && !cs.loading) return true;
        await ctx.page.mouse.wheel(0, -400);
        return false;
      },
      15000,
      'the wheel to reach the top of the scrollback',
    );
    const topOfHistory = await ctx.page.evaluate(() => {
      const box = document.querySelector('.pane-scroll-container').getBoundingClientRect();
      return [...document.querySelectorAll('[data-scroll-mode="true"] .terminal-line')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        })
        .map((el) => (el.textContent || '').trim());
    });
    expect(topOfHistory.some((line) => line.includes('click_test'))).toBe(true);
    expect(topOfHistory).not.toContain('100');

    // tmux is untouched: the pane never entered copy mode, so the application
    // in it carries on and no mode is advertised to the user.
    const duringScroll = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-scroll-mode="true"]');
      const pane = window.app.getSnapshot().context.panes[0];
      return {
        rendered: !!el && el.getBoundingClientRect().height > 0,
        userSelect: el ? getComputedStyle(el).userSelect : null,
        copyCursor: !!document.querySelector('.terminal-cursor-copy'),
        inMode: pane.inMode,
        statusSaysCopyMode: document.body.innerText.includes('[COPY MODE]'),
      };
    });
    expect(duringScroll.rendered).toBe(true);
    expect(duringScroll.userSelect).toBe('text');
    expect(duringScroll.copyCursor).toBe(false);
    expect(duringScroll.inMode).toBe(false);
    expect(duringScroll.statusSaysCopyMode).toBe(false);

    // Step 3: the scrollback selects with the browser's own selection, and the
    // text comes back without the grid's trailing padding.
    const selected = await ctx.page.evaluate(() => {
      const pre = document.querySelector('[data-scroll-mode="true"]');
      // Rows on screen: the scrollback also keeps an overscan of rows above
      // and below the viewport, and the right-click below must land on the
      // selection, not on whatever is drawn where an off-screen row projects.
      const box = document.querySelector('.pane-scroll-container').getBoundingClientRect();
      const rows = [...pre.children]
        .filter((d) => d.textContent.trim().length > 0)
        .filter((d) => {
          const r = d.getBoundingClientRect();
          return r.top > box.top + 2 && r.bottom < box.bottom - 2;
        });
      if (rows.length < 2) return null;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(rows[0], 0);
      range.setEnd(rows[1], rows[1].childNodes.length);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    expect(selected).not.toBeNull();
    expect(selected.trim().length).toBeGreaterThan(0);
    expect(selected).not.toMatch(/ {5}/);

    // Step 3b: the selection survives scrolling — in either direction and all
    // the way back to the bottom, where the view stays open for it — and a
    // right-click on it, which opens the menu with just Copy and Send keys.
    const readSelection = () => ctx.page.evaluate(() => window.getSelection()?.toString() ?? '');
    const scrollBy = async (rows) => {
      await ctx.page.evaluate((r) => {
        const el = document.querySelector('.pane-scroll-container');
        el.scrollTop +=
          r * parseFloat(getComputedStyle(el).getPropertyValue('--line-height-terminal'));
      }, rows);
      await afterFrames(ctx.page);
    };
    await scrollBy(6);
    expect(await readSelection()).toBe(selected);
    await scrollBy(-6);
    expect(await readSelection()).toBe(selected);
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.pane-scroll-container');
      el.scrollTop = el.scrollHeight;
    });
    await afterFrames(ctx.page);
    expect((await getCopyModeState(ctx.page))?.mode).toBe('scroll');
    expect(await readSelection()).toBe(selected);

    // Bring the selection back on screen (the bottom scrolled it out of the
    // viewport; its rows stayed mounted) and right-click on it.
    await ctx.page.evaluate(() => {
      const range = window.getSelection().getRangeAt(0);
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      el.closest('.terminal-line').scrollIntoView({ block: 'center' });
    });
    await afterFrames(ctx.page);
    expect(await readSelection()).toBe(selected);
    const selRect = await ctx.page.evaluate(() => {
      const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await ctx.page.mouse.click(selRect.x, selRect.y, { button: 'right' });
    await waitForCondition(
      ctx.page,
      () => ctx.page.evaluate(() => !!document.querySelector('[role^="menuitem"]')),
      5000,
      'the context menu to open',
    );
    expect(await readSelection()).toBe(selected);
    const menuItems = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('[role^="menuitem"]')].map((el) => ({
        text: el.textContent.trim(),
        icon: !!el.querySelector('svg.menu-item-icon'),
      })),
    );
    expect(menuItems).toEqual([
      { text: 'Copy', icon: true },
      { text: 'Send keys', icon: true },
    ]);
    // While the menu is up the selection is pinned: focus moving to the menu
    // (on open) or to an item (on hover) collapses it on WebKit, and whatever
    // collapses it, it comes back.
    await ctx.page.mouse.move(selRect.x + 30, selRect.y + 14);
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
    await waitForCondition(
      ctx.page,
      async () => (await readSelection()) === selected,
      3000,
      'the selection to be restored under the open menu',
    );
    // Escape puts the MENU away and stops there: one press dismisses the
    // surface you opened last, not everything behind it. The view the menu was
    // opened over is still up, and the key never reached the program in the
    // pane either.
    await ctx.page.keyboard.press('Escape');
    await waitForCondition(
      ctx.page,
      async () => (await ctx.page.$('[role="menu"]')) === null,
      5000,
      'the selection menu to close on Escape',
    );
    expect((await getCopyModeState(ctx.page))?.mode).toBe('scroll');
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // Step 4: typing closes the view and lands at the prompt, as in any
    // terminal — the key is not swallowed by a mode. Typed at the view, which
    // is what is on screen: the live screen is mounted but hidden behind it
    // (TerminalPane), so aiming at that would be aiming at something the user
    // cannot see either.
    await typeInTerminal(ctx.page, 'echo AFTER_SCROLL_VIEW', {
      target: '[data-testid="scrollback-terminal"]',
    });
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'AFTER_SCROLL_VIEW', 20000);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 5: a double-click selects natively and still enters no mode.
    await runCommand(ctx.page, 'echo "WORD1 WORD2 WORD3"', 'WORD1');
    const termEl = await ctx.page.$('[role="log"]');
    box = await termEl.boundingBox();
    await ctx.page.mouse.dblclick(box.x + 100, box.y + box.height / 2);
    // Copy mode is the client's own state, entered in the event handler: had
    // the double-click entered it, it would show within a frame or two.
    await afterFrames(ctx.page);
    const afterDblClick = await ctx.page.evaluate(() => ({
      selection: window.getSelection()?.toString() ?? '',
      copyState: window.app.getSnapshot().context.copyModeStates['%0'] ?? null,
    }));
    expect(afterDblClick.copyState).toBeNull();
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // Step 6: `prefix [` is the one way into copy mode, and it still works —
    // tmux really enters the mode and the client draws its cursor.
    const cs = await enterCopyModeAndWait(ctx.page);
    expect(cs.active).toBe(true);
    expect(cs.mode).toBe('copy');
    const inCopyMode = await ctx.page.evaluate(() => ({
      copyModeEl: !!document.querySelector('[data-copy-mode="true"]'),
      statusSaysCopyMode: document.body.innerText.includes('[COPY MODE]'),
    }));
    expect(inCopyMode.copyModeEl).toBe(true);
    expect(inCopyMode.statusSaysCopyMode).toBe(true);

    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    await runCommand(ctx.page, 'echo AFTER_COPY_MODE_OK', 'AFTER_COPY_MODE_OK');
    await assertContentMatch(ctx.page, 'Scenario 7 end');
  }, 180000);
});

// ==================== Scenario 7b: Right-click with nothing selected ====================

describe('Scenario 7b: Right-click with nothing selected', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  /** The labels of the menu that is open, waiting for one to be. */
  const openMenuLabels = async (page) => {
    await waitForCondition(
      page,
      () => page.evaluate(() => !!document.querySelector('[role="menu"] [role^="menuitem"]')),
      5000,
      'a menu to open',
    );
    return page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((el) =>
        el.textContent.trim(),
      ),
    );
  };
  const closeMenu = async (page) => {
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => (await page.$('[role="menu"]')) === null,
      5000,
      'the menu to close',
    );
  };

  test("opens the pane's own menu, the header's, and its Rename opens the header's field", async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await runCommand(ctx.page, 'echo RIGHT_CLICK_TARGET', 'RIGHT_CLICK_TARGET');
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());

    // The header's menu, for comparison.
    await ctx.page.locator('.pane-header').first().click({ button: 'right' });
    const fromHeader = await openMenuLabels(ctx.page);
    await closeMenu(ctx.page);

    // The content, on text but with nothing selected: the same menu, and no
    // word selected under the pointer.
    const box = await ctx.page.locator('[role="log"]').first().boundingBox();
    await ctx.page.mouse.click(box.x + 40, box.y + 8, { button: 'right' });
    const fromContent = await openMenuLabels(ctx.page);
    expect(fromContent).toEqual(fromHeader);
    expect(fromContent).toContain('Rename Pane');
    expect(await ctx.page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

    // Rename from it opens the field in the pane's header.
    await ctx.page.locator('[role="menuitem"]', { hasText: 'Rename Pane' }).first().click();
    await ctx.page.waitForSelector('.pane-header [data-testid="inline-rename"]', {
      timeout: 5000,
    });
    await ctx.page.keyboard.press('Escape');
    await waitForCondition(
      ctx.page,
      async () => (await ctx.page.$('[data-testid="inline-rename"]')) === null,
      5000,
      'the rename field to close',
    );
  }, 60000);
});

// ==================== Scenario 7c: Mouse lands on the clicked cell ====================

describe('Scenario 7c: Mouse lands on the clicked cell', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(async () => {
    await ensureMouseCaptureStopped(ctx);
    await ctx.afterEach();
  }, ctx.hookTimeout);

  test('a click reaches tmux at the cell under the pointer, in a pane and in the dock', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // 1. A tiled pane. The click on a cell's right half is the one that went
    //    wrong: positions were read from the padded content box, half a cell
    //    to the left of the first cell, so it landed in the next column.
    await startMouseCapture(ctx);
    const pane = await gridOf(ctx.page, '.pane-layout-item');
    for (const [col, row, frac] of [
      [10, 4, 0.5],
      [20, 6, 0.8],
      [3, 2, 0.2],
    ]) {
      const press = await clickCell(ctx.page, pane, col, row, frac);
      expect({ at: [col, row, frac], x: press.x, y: press.y }).toEqual({
        at: [col, row, frac],
        x: col + 1,
        y: row + 1,
      });
    }
    await stopMouseCapture(ctx);

    // 2. The dock. Its terminal runs in the smaller sidebar font, and clicks
    //    there were converted with the pane grid's larger cell: they reached
    //    tmux cells up and to the left of the pointer.
    await openSidebarKeyboard(ctx.page, 'right', { fixed: true });
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"] .terminal-line', {
      timeout: 20000,
    });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      10000,
      'the dock to take the keyboard',
    );
    await waitForShellPrompt(ctx.page);
    // Started in the dock's own terminal: by default the capture goes to the
    // active tiled pane.
    await startMouseCapture(ctx, {
      terminal: '[data-testid="right-sidebar-content"] [role="log"]',
    });
    const dock = await gridOf(ctx.page, '[data-testid="right-sidebar-content"]');
    expect(dock.cellW).toBeLessThan(pane.cellW);
    for (const [col, row, frac] of [
      [5, 8, 0.5],
      [20, 15, 0.8],
    ]) {
      const press = await clickCell(ctx.page, dock, col, row, frac);
      expect({ at: [col, row, frac], x: press.x, y: press.y }).toEqual({
        at: [col, row, frac],
        x: col + 1,
        y: row + 1,
      });
    }
    await stopMouseCapture(ctx);
    await ctx.page.click('button[aria-label="Toggle terminal sidebar"]');
  }, 180000);
});
