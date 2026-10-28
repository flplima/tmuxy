/**
 * Phone width, finger only
 *
 * The smallest viewport any other test opens is 800x600 and no other browser
 * context in the suite has `hasTouch` set — so on a real phone these run
 * nowhere else: the phone layout (utils/phoneLayout.ts — the whole 80 × 25
 * terminal, the key row and the tree under it), the hidden input that IS the
 * virtual keyboard (utils/mobileKeyboard.ts, whose `focusMobileInput`
 * returns immediately unless `navigator.maxTouchPoints > 0`), the key row's
 * latching ctrl, the swipe that opens the scroll view, and the tree standing
 * in for the tab strip.
 *
 * At this width the interesting failures are geometric: something overflows
 * the screen, or is drawn where no finger can reach it. Every assertion here
 * is therefore about boxes on screen, not about elements existing.
 */

const {
  PHONE,
  usePhoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  swipe,
} = require('./helpers/phone');
const {
  waitForTerminalText,
  getTerminalText,
  waitForCopyMode,
  getCopyModeState,
  createWindowKeyboard,
  waitForCondition,
  delay,
} = require('./helpers');

describe('Phone width (390px) with a touchscreen', () => {
  const ctx = usePhoneContext(PHONE);

  test('the whole 80 × 25 terminal over the keys and the tree; the ⌨ key opens the keyboard, ctrl latches, a swipe opens history, the tree switches tabs', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    // 1. Nothing runs off the side of the screen. A 400px-wide page that
    //    scrolls sideways is the whole class of phone layout bug, and it costs
    //    one number to rule out.
    const measureLayout = () =>
      ctx.page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
        };
        const ctx = window.app?.getSnapshot()?.context;
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          // Typing before the font settles types across a resize: the cell
          // is re-measured when the face loads, the grid asks tmux for new
          // columns, and zsh redraws the half-typed line at the old width —
          // the `ffori in $$(seq` the screen showed.
          fontsLoaded: document.fonts.status === 'loaded',
          pane: box(document.querySelector('.pane-active [role="log"]')),
          tabs: box(document.querySelector('.tab-list')),
          container: box(document.querySelector('.phone-pty .pane-container')),
          status: box(document.querySelector('.phone-pty .tmux-status-bar')),
          keys: box(document.querySelector('.key-row')),
          tree: box(document.querySelector('.phone-tree')),
          // What the grid was sized from, for a failure to be readable: the
          // client's target against what tmux actually reports, and the panes
          // it reports it for.
          grid: ctx && {
            containerWidth: ctx.containerWidth,
            charWidth: ctx.charWidth,
            totalWidth: ctx.totalWidth,
            targetCols: ctx.targetCols,
            totalHeight: ctx.totalHeight,
            targetRows: ctx.targetRows,
            phoneLayout: ctx.phoneLayout ?? null,
            sidebarMotion: ctx.sidebarMotion ?? null,
            leftSidebar: ctx.leftSidebarOpen ?? null,
            rightSidebar: ctx.rightSidebarOpen ?? null,
            panes: (ctx.panes ?? []).map((p) => `${p.tmuxId} ${p.width}x${p.height}`),
          },
        };
      });
    // Following the viewport is a round trip, not a reflow: the client asks
    // tmux for the columns it measured and redraws when tmux says it resized.
    // On a slow machine that took longer than the five seconds this used to
    // allow, and the sample caught the terminal still at the session's opening
    // 200 columns — `targetCols: 41, totalWidth: 200` in the failure. So it
    // waits for the grid to BE the one asked for, which is the thing the
    // geometry below is about, and waits as long as the rest of the suite does.
    let layout = null;
    let previous = null;
    const fits = (l) =>
      l &&
      l.pane &&
      l.grid &&
      l.fontsLoaded &&
      // The cell has stopped changing size: two samples agree.
      previous?.grid?.charWidth === l.grid.charWidth &&
      l.grid.totalWidth === 80 &&
      l.grid.targetCols === 80 &&
      l.pane.right <= PHONE.width + 1 &&
      l.docScrollWidth <= PHONE.width + 1;
    await waitForCondition(
      ctx.page,
      async () => {
        previous = layout;
        layout = await measureLayout();
        return fits(layout);
      },
      20000,
      () => `the 80-column grid to fit the phone's width (last: ${JSON.stringify(layout)})`,
    );
    expect(layout.docScrollWidth).toBeLessThanOrEqual(PHONE.width + 1);
    expectOnScreen(layout.pane, 'the terminal', PHONE.width, { grid: layout.grid });
    // The phone layout: the tab strip over the terminal; 80 columns span the
    // screen edge to edge, and tmux's line under them is as wide.
    expect(layout.grid.phoneLayout).toBe(true);
    expectOnScreen(layout.tabs, 'the tab strip');
    expect(layout.tabs.top + layout.tabs.height).toBeLessThanOrEqual(layout.container.top + 1);
    expect(layout.container.left).toBeCloseTo(0, 0);
    expect(layout.container.width).toBeCloseTo(PHONE.width, 0);
    expect(80 * layout.grid.charWidth).toBeCloseTo(layout.grid.containerWidth, 1);
    // 4px of padding each side: the grid's outer borders stay on screen.
    expect(layout.grid.containerWidth).toBeCloseTo(PHONE.width - 8, 0);
    expect(layout.pane.left).toBeGreaterThanOrEqual(1);
    // Top to bottom: the tabs, the grid, tmux's line as its 25th row, the
    // keys, the tree.
    expectOnScreen(layout.status, 'the status line');
    expect(layout.status.left).toBeCloseTo(0, 0);
    expect(layout.status.width).toBeCloseTo(PHONE.width, 0);
    expectOnScreen(layout.keys, 'the key row');
    expectOnScreen(layout.tree, 'the tree');
    expect(layout.status.top).toBeGreaterThanOrEqual(
      layout.container.top + layout.container.height - 1,
    );
    expect(layout.keys.top).toBeGreaterThanOrEqual(layout.status.top + layout.status.height - 1);
    expect(layout.tree.top).toBeGreaterThanOrEqual(layout.keys.top + layout.keys.height - 1);
    // A terminal squeezed to nothing is "on screen" too; it has to be usable.
    expect(layout.pane.height).toBeGreaterThan(200);

    // 2. The virtual keyboard. A tap on the terminal only focuses the pane —
    //    the keyboard stays down — and the key row's ⌨ key is what opens it:
    //    the hidden input is only focused for a device with touch points, so
    //    on this path alone does the phone get a keyboard at all.
    const target = { x: layout.pane.left + layout.pane.width / 2, y: layout.pane.top + 40 };
    // The tap's own handler runs before the tap resolves: a keyboard it had
    // opened would already have the focus.
    await ctx.page.touchscreen.tap(target.x, target.y);
    expect(await ctx.page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    const keyRowKey = async (label) =>
      ctx.page.evaluate((l) => {
        const r = document.querySelector(`[data-key-row="${l}"]`).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, label);
    const keyboardKey = await keyRowKey('⌨');
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.activeElement;
          return !!el && el.tagName === 'INPUT' && getComputedStyle(el).position === 'fixed';
        }),
      5000,
      'the ⌨ key to open the keyboard (focus the hidden input)',
    );

    // What is typed on it reaches the shell and comes back on screen — and
    // `waitForTerminalText` only counts text in a box the user can see.
    await typeOnVirtualKeyboard(ctx.page, 'echo TOUCH_KBD_OK');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'TOUCH_KBD_OK', 20000);

    // The key row's ctrl latches for the next key typed on the phone's own
    // keyboard: ctrl, then c, interrupts a running sleep — the echo after it
    // runs at once instead of in a minute.
    await typeOnVirtualKeyboard(ctx.page, 'sleep 60');
    await ctx.page.keyboard.press('Enter');
    const ctrlKey = await keyRowKey('ctrl');
    await ctx.page.touchscreen.tap(ctrlKey.x, ctrlKey.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () =>
            document.querySelector('[data-key-row="ctrl"]').getAttribute('aria-pressed') === 'true',
        ),
      5000,
      'ctrl to latch',
    );
    // The keyboard stays up: the key row never takes the focus.
    expect(await ctx.page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
    await typeOnVirtualKeyboard(ctx.page, 'c');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () =>
            document.querySelector('[data-key-row="ctrl"]').getAttribute('aria-pressed') ===
            'false',
        ),
      5000,
      'ctrl to let go after one key',
    );
    // ⏎ from the key row runs the line.
    await typeOnVirtualKeyboard(ctx.page, 'echo CTRL_C_OK');
    const enterKey = await keyRowKey('⏎');
    await ctx.page.touchscreen.tap(enterKey.x, enterKey.y);
    await waitForTerminalText(ctx.page, 'CTRL_C_OK', 15000, { notOnLineWith: 'echo CTRL' });

    // The ⌨ key again puts the keyboard away, which is the only way to get
    // the screen back on a phone; a tap on the terminal leaves it as it is.
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.activeElement;
          return !el || el.tagName !== 'INPUT';
        }),
      5000,
      'the ⌨ key again to dismiss the keyboard',
    );
    await ctx.page.touchscreen.tap(target.x, target.y);
    expect(await ctx.page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');

    // 3. The scroll view. Print more history than the screen holds, then drag
    //    it down with a finger the way every other app scrolls.
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
      5000,
      'the keyboard to come back for the second command',
    );
    await typeOnVirtualKeyboard(ctx.page, 'for i in $(seq 0 79); do echo "line-$i"; done');
    await ctx.page.keyboard.press('Enter');
    await waitForTerminalText(ctx.page, 'line-79', 20000);
    const lowestLine = (text) => {
      const numbers = [...text.matchAll(/line-(\d+)/g)].map((m) => Number(m[1]));
      return numbers.length > 0 ? Math.min(...numbers) : null;
    };
    const liveLowest = lowestLine(await getTerminalText(ctx.page));
    // The screen cannot hold 80 lines at this height, so the early ones have
    // scrolled off — they are what the swipe has to bring back.
    expect(liveLowest).toBeGreaterThan(0);

    const pane = await ctx.page.evaluate(() => {
      const r = document.querySelector('.pane-active [role="log"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, top: r.top, height: r.height };
    });
    // Finger DOWN = look further back, the natural-scrolling convention.
    await swipe(ctx.page, pane.x, pane.top + pane.height * 0.25, pane.top + pane.height * 0.85);
    const scroll = await waitForCopyMode(ctx.page, true, 15000);
    expect(scroll.mode).toBe('scroll');

    // The view is not just in the state machine: it covers the pane, inside
    // the screen, showing rows that had scrolled off.
    const view = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback-terminal"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.terminal-line')]
        .filter((l) => {
          const b = l.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight;
        })
        .map((l) => l.textContent);
      return {
        box: { left: r.left, right: r.right, width: r.width, height: r.height },
        rows,
      };
    });
    expect(view).not.toBeNull();
    expectOnScreen(view.box, 'the scroll view');
    expect(view.rows.length).toBeGreaterThan(5);
    // …and it brought back rows the live screen had already lost: that is
    // what the swipe was for.
    expect(lowestLine(view.rows.join('\n'))).toBeLessThan(liveLowest);

    await ctx.page.keyboard.press('Escape');
    await waitForCopyMode(ctx.page, false, 15000);
    expect(await getCopyModeState(ctx.page)).toBeNull();

    // 4. The tree stands in for the tab strip. The second window is setup;
    //    switching back to the first with a finger is the feature.
    await createWindowKeyboard(ctx.page);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const rows = document.querySelectorAll('.phone-tree .sidebar-tree-tab');
          return rows.length === 2 && rows[1].classList.contains('is-active');
        }),
      15000,
      'the new tab to show in the tree, current',
    );

    const tabs = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.phone-tree .sidebar-tree-tab')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          active: el.classList.contains('is-active'),
          left: r.left,
          right: r.right,
          top: r.top,
          width: r.width,
          height: r.height,
        };
      }),
    );
    expect(tabs.length).toBe(2);
    for (const [i, tab] of tabs.entries()) {
      expectOnScreen(tab, `tree row ${i + 1}`);
      // A tap target below this is not reachable with a thumb.
      expect({ i, tall: tab.height >= 18 }).toEqual({ i, tall: true });
    }
    expect(tabs[1].active).toBe(true);

    await ctx.page.touchscreen.tap(
      tabs[0].left + tabs[0].width / 2,
      tabs[0].top + tabs[0].height / 2,
    );
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() =>
          document.querySelector('.phone-tree .sidebar-tree-tab')?.classList.contains('is-active'),
        ),
      15000,
      'tapping the first tab in the tree to switch back to it',
    );

    // The window it switched to is the one that ran the commands, still
    // rendered and still on screen — the last line it printed, not a tab that
    // switched to an empty grid.
    await waitForTerminalText(ctx.page, 'line-79', 15000);
  }, 240000);
});
