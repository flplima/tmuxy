/**
 * Input & Interaction E2E Tests (Copy Mode Navigation, Selection & Yank)
 */

const {
  createTestContext,
  focusPage,
  runCommand,
  assertContentMatch,
  getCopyModeState,
  wheelIntoScrollView,
  waitForCondition,
  waitForCopyMode,
  waitForTmuxOutOfMode,
  enterCopyModeAndWait,
  createWindowKeyboard,
  activeWindowId,
} = require('./helpers');

/**
 * The copy-mode state once `pred` holds for it. Copy mode runs in the client,
 * so a key's effect lands in the app's copy-mode state: wait for the state the
 * key should produce, and fail with what the state was if it never does.
 */
async function copyStateWhere(page, pred, desc) {
  let state = null;
  await waitForCondition(
    page,
    async () => !!(state = await getCopyModeState(page)) && pred(state),
    5000,
    () => `${desc} (copy state: ${JSON.stringify(state)})`,
  );
  return state;
}

// ==================== Scenario 9: Copy Mode Navigate ====================

describe('Scenario 9: Copy Mode Navigate', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Scroll enter → hjkl cursor → 0/$ line edges → Ctrl+u/d half-page → persists → exit q → re-enter scroll → exit Escape → v selection', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate scrollback content
    await runCommand(ctx.page, 'seq 1 200', '200');
    await focusPage(ctx.page);
    await assertContentMatch(ctx.page, 'Scenario 9 setup');

    // Step 1: Enter copy mode (keyboard: prefix+[)
    const csEntry = await enterCopyModeAndWait(ctx.page);
    expect(csEntry.active).toBe(true);

    const copyState = (pred, desc) => copyStateWhere(ctx.page, pred, desc);
    const ctrl = async (key) => {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press(key);
      await ctx.page.keyboard.up('Control');
    };

    // Step 2: Navigate with 'k' (up) — cursor row should decrease
    const before = await getCopyModeState(ctx.page);
    for (let i = 0; i < 3; i++) await ctx.page.keyboard.press('k');
    const afterUp = await copyState(
      (s) => s.cursorRow === before.cursorRow - 3,
      'kkk to move the cursor up three rows',
    );

    // Navigate with 'j' (down) — cursor row should increase
    await ctx.page.keyboard.press('j');
    await copyState((s) => s.cursorRow === afterUp.cursorRow + 1, 'j to move the cursor down');

    // Move up a few lines onto a "seq" output line (not the empty prompt),
    // to the start of it.
    await ctx.page.keyboard.press('0');
    for (let i = 0; i < 3; i++) await ctx.page.keyboard.press('k');
    await ctx.page.keyboard.press('0');
    await copyState(
      (s) => s.cursorRow === afterUp.cursorRow - 2 && s.cursorCol === 0,
      'the cursor at the start of a seq line',
    );

    // Navigate with 'l' (right) — cursor col should increase
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    const afterRight = await copyState((s) => s.cursorCol > 0, 'll to move the cursor right');

    // Navigate with 'h' (left) — cursor col should decrease
    await ctx.page.keyboard.press('h');
    await copyState((s) => s.cursorCol < afterRight.cursorCol, 'h to move the cursor left');

    // Step 3: Line edges: '0' goes to col 0, '$' goes to end of line
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('0');
    await copyState((s) => s.cursorCol === 0, '0 to move the cursor to the line start');

    await ctx.page.keyboard.press('$');
    await copyState((s) => s.cursorCol > 0, '$ to move the cursor to the line end');

    // Step 4: Half-page up/down (Ctrl+u / Ctrl+d)
    const beforePage = await getCopyModeState(ctx.page);
    await ctrl('u');
    const afterPageUp = await copyState(
      (s) => s.cursorRow < beforePage.cursorRow,
      'Ctrl+u to move half a page up',
    );

    await ctrl('d');
    await copyState((s) => s.cursorRow > afterPageUp.cursorRow, 'Ctrl+d to move half a page down');

    // Step 5: Still in copy mode after all navigation
    const csStillActive = await getCopyModeState(ctx.page);
    expect(csStillActive.active).toBe(true);
    // ScrollbackTerminal should be rendered
    const scrollbackEl = await ctx.page.$('[data-copy-mode="true"]');
    expect(scrollbackEl).not.toBeNull();

    // Step 5b: wheel up through the history until the render window has
    // cleared the bottom row. Every row drawn must hold the content of the
    // row it stands for, in order: the renderer used to reuse its divs across
    // scroll positions and skip the redraw, leaving div 9 on row 107 and div
    // 10 on row 127. `seq` gives every row a number, so the rendered numbers
    // must form one consecutive run that reflects the scrolled-up position
    // rather than the band that was on screen.
    const paneBox = await ctx.page.evaluate(() => {
      const r = document.querySelector('[data-pane-id]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await ctx.page.mouse.move(paneBox.x, paneBox.y);
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        if (cs && !cs.loading && cs.scrollTop + 3 * cs.height < cs.totalLines - 1) return true;
        await ctx.page.mouse.wheel(0, -200);
        return false;
      },
      15000,
      'the wheel to carry the render window clear of the bottom row',
    );
    const renderedRows = () =>
      ctx.page.evaluate(() =>
        [...document.querySelectorAll('[data-copy-mode="true"] .terminal-line')].map((el) => {
          const text = (el.textContent || '').trim();
          return /^\d+$/.test(text) ? Number(text) : null;
        }),
      );
    const runsOf = (rows) => {
      const runs = [];
      let run = [];
      for (const n of rows) {
        if (n === null) {
          if (run.length) runs.push(run);
          run = [];
        } else run.push(n);
      }
      if (run.length) runs.push(run);
      return runs.sort((a, b) => b.length - a.length);
    };
    const longest = runsOf(await renderedRows())[0] || [];
    expect(longest.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < longest.length; i++) expect(longest[i]).toBe(longest[i - 1] + 1);
    expect(longest).not.toContain(200);
    expect(longest[0]).toBeLessThan(170);

    // Step 5c: `gg` to the very top. The oldest line is drawn there, on
    // screen, from the full history — not a placeholder, and not the newest
    // rows the fetch used to be capped to.
    await ctx.page.keyboard.press('g');
    await ctx.page.keyboard.press('g');
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        return !!cs && cs.scrollTop === 0 && !cs.loading;
      },
      15000,
      'gg to scroll the view to the top of the history',
    );
    const topOfHistory = await ctx.page.evaluate(() => {
      const box = document.querySelector('.pane-scroll-container').getBoundingClientRect();
      return [...document.querySelectorAll('[data-copy-mode="true"] .terminal-line')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        })
        .map((el) => (el.textContent || '').trim());
    });
    expect(topOfHistory).toContain('1');
    expect(topOfHistory).not.toContain('200');

    // Step 6: Exit with 'q'
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();
    // ScrollbackTerminal should be gone, normal terminal restored
    const normalEl = await ctx.page.$('[role="log"]');
    expect(normalEl).not.toBeNull();

    // Step 7: Re-enter copy mode — once tmux has confirmed the exit, not
    // after a sleep: the cancel is a round trip, and a re-entry that races it
    // is closed by the snapshot reporting it (see waitForTmuxOutOfMode).
    await waitForTmuxOutOfMode(ctx.page);
    await enterCopyModeAndWait(ctx.page);

    // Step 8: Exit with Escape
    await ctx.page.keyboard.press('Escape');
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 9: Re-enter, test 'v' selection mode
    await waitForTmuxOutOfMode(ctx.page);
    await enterCopyModeAndWait(ctx.page);
    // Navigate up to a line with content (the "seq 1 200" command output)
    for (let i = 0; i < 5; i++) await ctx.page.keyboard.press('k');
    // Move to start of line so we have room to move right
    await ctx.page.keyboard.press('0');
    await copyStateWhere(
      ctx.page,
      (s) => s.cursorCol === 0,
      'kkkkk then 0 to put the cursor at a line start',
    );
    // Press 'v' to enter char selection mode
    await ctx.page.keyboard.press('v');
    await waitForCondition(
      ctx.page,
      async () => (await getCopyModeState(ctx.page))?.selectionMode === 'char',
      5000,
      "'v' to open a char selection",
    );
    const csWithSelection = await getCopyModeState(ctx.page);
    expect(csWithSelection.selectionAnchor).not.toBeNull();
    expect(csWithSelection.cursorCol).toBe(0);
    // Move cursor right to expand selection
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await ctx.page.keyboard.press('l');
    await waitForCondition(
      ctx.page,
      async () => ((await getCopyModeState(ctx.page))?.cursorCol ?? 0) > csWithSelection.cursorCol,
      5000,
      'the cursor to move right inside the selection',
    );
    // 'v' again toggles off selection
    await ctx.page.keyboard.press('v');
    await waitForCondition(
      ctx.page,
      async () => {
        const cs = await getCopyModeState(ctx.page);
        return !!cs && cs.selectionMode === null;
      },
      5000,
      "'v' again to drop the selection",
    );

    // Clean exit
    await ctx.page.keyboard.press('q');
    await waitForCopyMode(ctx.page, false);
    // Force content sync: after copy mode exit the terminal DOM may be stale.
    // Running a command forces fresh content that matches tmux ground truth.
    await runCommand(ctx.page, 'echo COPY_EXIT', 'COPY_EXIT');
    await assertContentMatch(ctx.page, 'Scenario 9 end');
  }, 180000);
});

// ==================== Scenario 9b: Copy Mode Across a Tab Switch ====================

/**
 * What the active pane's scrollback container shows: its offset in rows, and
 * the text of the row drawn at its middle (empty when nothing is drawn there).
 */
function scrollbackOnScreen(page) {
  return page.evaluate(() => {
    const { activePaneId, charHeight } = window.app.getSnapshot().context;
    const el = document.querySelector(
      `.pane-wrapper[data-pane-id="${activePaneId}"] .pane-scroll-container`,
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      row: Math.round(el.scrollTop / charHeight),
      height: r.height,
      text: hit?.closest('.terminal-line')?.textContent?.trim() ?? '',
    };
  });
}

describe('Scenario 9b: Copy Mode Across a Tab Switch', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a pane in copy mode comes back from another tab drawn where it was, and the wheel moves on from there', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A second tab to go to, then back to the first with history behind it.
    const first = await activeWindowId(ctx.page);
    await createWindowKeyboard(ctx.page);
    const second = await activeWindowId(ctx.page);
    await ctx.page.click(`.tab-name[data-window-id="${first}"]`);
    await waitForCondition(
      ctx.page,
      async () => (await activeWindowId(ctx.page)) === first,
      10000,
      'the first tab to be current again',
    );
    await runCommand(ctx.page, 'seq 1 600', '600');

    // Copy mode, a few half-pages up into the history.
    await focusPage(ctx.page);
    const entry = await enterCopyModeAndWait(ctx.page);
    for (let i = 0; i < 4; i++) {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('u');
      await ctx.page.keyboard.up('Control');
    }
    const scrolled = await copyStateWhere(
      ctx.page,
      (s) => s.scrollTop < entry.scrollTop - 20 && !s.loading,
      'four Ctrl+u to scroll the copy-mode view up',
    );
    let shown = null;
    await waitForCondition(
      ctx.page,
      async () => !!(shown = await scrollbackOnScreen(ctx.page)) && /^\d+$/.test(shown.text),
      10000,
      () => `history rows drawn in the scrolled view (${JSON.stringify(shown)})`,
    );

    // Away and back. The pane was display:none in between.
    await ctx.page.click(`.tab-name[data-window-id="${second}"]`);
    await waitForCondition(
      ctx.page,
      async () => (await activeWindowId(ctx.page)) === second,
      10000,
      'the second tab to be current',
    );
    await ctx.page.click(`.tab-name[data-window-id="${first}"]`);
    await waitForCondition(
      ctx.page,
      async () => (await activeWindowId(ctx.page)) === first,
      10000,
      'the first tab to be current again',
    );

    // Still in copy mode, at the same row, with that row's text on screen —
    // not an empty spacer at the top of the history.
    const back = await copyStateWhere(ctx.page, (s) => s.mode === 'copy', 'copy mode to survive');
    expect(back.scrollTop).toBe(scrolled.scrollTop);
    await waitForCondition(
      ctx.page,
      async () =>
        !!(shown = await scrollbackOnScreen(ctx.page)) &&
        shown.height > 0 &&
        Math.abs(shown.row - scrolled.scrollTop) <= 1 &&
        /^\d+$/.test(shown.text),
      10000,
      () => `the view drawn at row ${scrolled.scrollTop} again (${JSON.stringify(shown)})`,
    );

    // A wheel step moves on from that row, not from the top of the history.
    const box = await ctx.page.evaluate(() => {
      const r = document.querySelector('.pane-scroll-container').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(box.x, box.y);
    await ctx.page.mouse.wheel(0, 120);
    const wheeled = await copyStateWhere(
      ctx.page,
      (s) => s.scrollTop !== scrolled.scrollTop,
      'the wheel to move the view',
    );
    expect(wheeled.scrollTop).toBeGreaterThan(scrolled.scrollTop);
  }, 120000);

  test('a wheel scroll view left open on a tab is closed by leaving it, and the tab comes back live', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const first = await activeWindowId(ctx.page);
    await createWindowKeyboard(ctx.page);
    const second = await activeWindowId(ctx.page);
    const select = async (windowId, label) => {
      await ctx.page.click(`.tab-name[data-window-id="${windowId}"]`);
      await waitForCondition(
        ctx.page,
        async () => (await activeWindowId(ctx.page)) === windowId,
        10000,
        label,
      );
    };
    await select(first, 'the first tab to be current again');
    await runCommand(ctx.page, 'seq 1 600', '600');

    // The wheel opens the client's scroll view over the history.
    const pane = await ctx.page.evaluate(() => {
      const { activePaneId } = window.app.getSnapshot().context;
      const r = document
        .querySelector(`.pane-wrapper[data-pane-id="${activePaneId}"] .pane-scroll-container`)
        .getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(pane.x, pane.y);
    await wheelIntoScrollView(ctx.page);

    await select(second, 'the second tab to be current');
    await select(first, 'the first tab to be current again');

    // Back on the tab: no view held open over it, and its live screen drawn —
    // a real box with the last output on it.
    let live = null;
    await waitForCondition(
      ctx.page,
      async () => {
        live = await ctx.page.evaluate(() => {
          const { activePaneId, copyModeStates } = window.app.getSnapshot().context;
          const log = document.querySelector(
            `.pane-wrapper[data-pane-id="${activePaneId}"] [role="log"]`,
          );
          const r = log?.getBoundingClientRect();
          return {
            view: copyModeStates[activePaneId]?.mode ?? null,
            height: r?.height ?? 0,
            text: log?.textContent ?? '',
          };
        });
        return live.view === null && live.height > 0 && live.text.includes('600');
      },
      10000,
      () =>
        `the tab to come back on its live screen (${JSON.stringify(live?.view)}, ${live?.height})`,
    );

    // The next wheel opens a view from the bottom, not from the top of history.
    await ctx.page.mouse.move(pane.x, pane.y);
    const reopened = await wheelIntoScrollView(ctx.page);
    expect(reopened.scrollTop).toBeGreaterThan(reopened.totalLines - reopened.height - 20);
  }, 120000);
});

// ==================== Scenario 10: Copy Mode Select & Yank ====================

describe('Scenario 10: Copy Mode Select & Yank', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Selection with v → yank with y → exit → terminal functional', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Generate scrollback content with identifiable lines
    await runCommand(ctx.page, 'seq 1 200', '200');
    await focusPage(ctx.page);
    await assertContentMatch(ctx.page, 'Scenario 10 setup');

    // Step 2: Enter copy mode via keyboard (prefix+[)
    const csEntry = await enterCopyModeAndWait(ctx.page);
    expect(csEntry.active).toBe(true);

    // Step 3: Navigate up to a content line with 'k'
    for (let i = 0; i < 5; i++) await ctx.page.keyboard.press('k');
    await copyStateWhere(
      ctx.page,
      (s) => s.cursorRow === csEntry.cursorRow - 5,
      'kkkkk to move the cursor up five rows',
    );

    // Step 4: Go to start of line with '0'
    await ctx.page.keyboard.press('0');
    const atStart = await copyStateWhere(
      ctx.page,
      (s) => s.cursorCol === 0,
      '0 to move the cursor to the line start',
    );

    // Step 5: Enter char selection with 'v'
    await ctx.page.keyboard.press('v');
    await copyStateWhere(ctx.page, (s) => s.selectionMode === 'char', "'v' to start a selection");

    // Step 6: Extend selection with 'l' keys
    for (let i = 0; i < 3; i++) await ctx.page.keyboard.press('l');
    await copyStateWhere(
      ctx.page,
      (s) => s.cursorCol > atStart.cursorCol,
      'lll to extend the selection',
    );

    // Step 7: Yank with 'y' (triggers extractSelectedText → clipboard → auto-exit)
    await ctx.page.keyboard.press('y');

    // Step 8: Verify copy mode exited after yank
    await waitForCopyMode(ctx.page, false);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // Step 9: Verify terminal is functional after yank
    await runCommand(ctx.page, 'echo "YANK_OK"', 'YANK_OK');
    await assertContentMatch(ctx.page, 'Scenario 10 end');
  }, 180000);
});
