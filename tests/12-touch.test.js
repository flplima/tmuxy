/**
 * Phone width, finger only
 *
 * The smallest viewport any other test opens is 800x600 and no other browser
 * context in the suite has `hasTouch` set — so on a real phone these run
 * nowhere else: the phone layout (infra/dom/phoneLayout.ts — the whole 80 × 25
 * terminal, the key row, and under a bar the tree with its tab bar on top),
 * the hidden input that IS the virtual keyboard (infra/dom/mobileKeyboard.ts,
 * whose `focusMobileInput`
 * returns immediately unless `navigator.maxTouchPoints > 0`), the key row's
 * latching ctrl, the swipe that opens the scroll view, and the desktop's tab
 * strip along the top, which a finger taps, with the tree listing the same
 * tabs.
 *
 * At this width the interesting failures are geometric: something overflows
 * the screen, or is drawn where no finger can reach it. Every assertion here
 * is therefore about boxes on screen, not about elements existing.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  swipe,
  boxOf,
} = require('./helpers/phone');
const { tmuxWindow } = require('./helpers/tmux-read');
const {
  describeE2E,
  waitForTerminalText,
  getTerminalText,
  waitForCopyMode,
  getCopyModeState,
  waitForCondition,
} = require('./helpers');

describeE2E('Phone width (390px) with a touchscreen', { context: phoneContext(PHONE) }, (ctx) => {
  test('the tab strip over the whole 80 × 25 terminal, the keys and the tree; a tap on the pane opens the keyboard and another puts it away, ctrl latches, a swipe opens history, + on the strip makes a tab, a tap on the strip switches tabs, and so does the tree', async () => {
    await ctx.setupPage();

    // 1. Nothing runs off the side of the screen. A 400px-wide page that
    //    scrolls sideways is the whole class of phone layout bug, and it costs
    //    one number to rule out.
    const measureLayout = async () => {
      const seen = await ctx.page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
        };
        const log = document.querySelector('.pane-active [role="log"]');
        const container = document.querySelector('.phone-pty .pane-container');
        const pad = container && getComputedStyle(container);
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          // Typing before the font settles types across a resize: the cell
          // is re-measured when the face loads, the grid asks tmux for new
          // columns, and zsh redraws the half-typed line at the old width —
          // the `ffori in $$(seq` the screen showed.
          fontsLoaded: document.fonts.status === 'loaded',
          pane: box(log),
          strip: box(document.querySelector('[data-testid="phone-tab-strip"]')),
          keyHeights: [...document.querySelectorAll('.key-row-key')].map(
            (k) => k.getBoundingClientRect().height,
          ),
          container: box(container),
          status: box(document.querySelector('.phone-pty .tmux-status-bar')),
          keys: box(document.querySelector('.key-row')),
          bar: box(document.querySelector('[data-testid="phone-divider"]')),
          tree: box(document.querySelector('.phone-tree')),
          tabs: box(document.querySelector('.phone-tabs')),
          tabNames: [...document.querySelectorAll('.phone-tabs [role="tab"]')].map(
            (t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`,
          ),
          // The grid as drawn: its cell, the width inside the container's
          // padding, and whether it is the phone's terminal at all.
          grid: log &&
            container && {
              charWidth: parseFloat(getComputedStyle(log).getPropertyValue('--cell-w')),
              containerWidth:
                container.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
              phoneLayout: document.querySelector('.phone-pty') !== null,
            },
          tab: window.app?.view().activeTabId ?? null,
        };
      });
      // What tmux sized the tab to: the columns the client asked for, once it has.
      if (seen.grid && seen.tab) seen.grid.totalWidth = tmuxWindow(seen.tab).width;
      return seen;
    };
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
    // The phone layout: the desktop's tab strip along the top of the screen,
    // the terminal right under it; 80 columns span it edge to edge, and
    // tmux's line under them is as wide.
    expect(layout.grid.phoneLayout).toBe(true);
    expectOnScreen(layout.strip, 'the tab strip');
    expect(layout.strip.top).toBeCloseTo(0, 0);
    expect(layout.strip.width).toBeCloseTo(PHONE.width, 0);
    expect(layout.container.top).toBeCloseTo(layout.strip.top + layout.strip.height, 0);
    expect(layout.container.left).toBeCloseTo(0, 0);
    expect(layout.container.width).toBeCloseTo(PHONE.width, 0);
    expect(80 * layout.grid.charWidth).toBeCloseTo(layout.grid.containerWidth, 1);
    // 4px of padding each side: the grid's outer borders stay on screen.
    expect(layout.grid.containerWidth).toBeCloseTo(PHONE.width - 8, 0);
    expect(layout.pane.left).toBeGreaterThanOrEqual(1);
    // Top to bottom: the grid, tmux's line as its 25th row, the keys, the
    // bar, then the tab bar — the menu, the tree in front, the side pane —
    // and the tree under it down to the screen's bottom.
    expectOnScreen(layout.status, 'the status line');
    expect(layout.status.left).toBeCloseTo(0, 0);
    expect(layout.status.width).toBeCloseTo(PHONE.width, 0);
    expectOnScreen(layout.keys, 'the key row');
    expectOnScreen(layout.tree, 'the tree');
    expect(layout.status.top).toBeGreaterThanOrEqual(
      layout.container.top + layout.container.height - 1,
    );
    expect(layout.keys.top).toBeGreaterThanOrEqual(layout.status.top + layout.status.height - 1);
    // Twelve keys, each shorter than the 41px they used to take, still a
    // thumb's height.
    expect(layout.keyHeights).toHaveLength(12);
    expect(Math.min(...layout.keyHeights)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...layout.keyHeights)).toBeLessThanOrEqual(33);
    expectOnScreen(layout.bar, 'the bar');
    expect(layout.bar.top).toBeCloseTo(layout.keys.top + layout.keys.height, 0);
    expectOnScreen(layout.tabs, 'the tab bar');
    expect(layout.tabNames).toEqual(['Menu', 'Tree*', 'Side pane']);
    expect(layout.tabs.top).toBeCloseTo(layout.bar.top + layout.bar.height, 0);
    expect(layout.tree.top).toBeGreaterThanOrEqual(layout.tabs.top + layout.tabs.height - 1);
    expect(layout.tree.top + layout.tree.height).toBeCloseTo(PHONE.height, 0);
    // A terminal squeezed to nothing is "on screen" too; it has to be usable.
    expect(layout.pane.height).toBeGreaterThan(200);

    // 2. The virtual keyboard. A tap on the terminal — the pane in front —
    //    opens it, as the key row's ⌨ key does: the hidden input is only
    //    focused for a device with touch points, so on these paths alone
    //    does the phone get a keyboard at all. The tap's own handler has to
    //    do it: a phone brings its keyboard up inside the tap, never later.
    const target = { x: layout.pane.left + layout.pane.width / 2, y: layout.pane.top + 40 };
    const keyboardUp = () =>
      ctx.page.evaluate(() => {
        const el = document.activeElement;
        return !!el && el.tagName === 'INPUT' && getComputedStyle(el).position === 'fixed';
      });
    const keyRowKey = async (label) =>
      ctx.page.evaluate((l) => {
        const r = document.querySelector(`[data-key-row="${l}"]`).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, label);
    const keyboardKey = await keyRowKey('⌨');
    await ctx.page.touchscreen.tap(target.x, target.y);
    await waitForCondition(
      ctx.page,
      keyboardUp,
      5000,
      'a tap on the pane in front to open the keyboard (focus the hidden input)',
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

    // A tap on the terminal again puts the keyboard away, and the screen
    // comes back.
    await ctx.page.touchscreen.tap(target.x, target.y);
    await waitForCondition(
      ctx.page,
      async () => !(await keyboardUp()),
      5000,
      'a second tap on the pane to put the keyboard away',
    );

    // 3. The scroll view. Print more history than the screen holds, then drag
    //    it down with a finger the way every other app scrolls.
    // The ⌨ key brings it back.
    await ctx.page.touchscreen.tap(keyboardKey.x, keyboardKey.y);
    await waitForCondition(ctx.page, keyboardUp, 5000, 'the ⌨ key to bring the keyboard back');
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

    // 4. The tab strip. + on it makes a tab, current, and both tabs are on
    //    the strip, each a thumb's height; a tap on the first switches back
    //    to it.
    const stripTabs = () =>
      ctx.page.evaluate(() =>
        [
          ...document.querySelectorAll('[data-testid="phone-tab-strip"] .tab-name[data-window-id]'),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.windowId,
            name: el.textContent,
            active: el.getAttribute('aria-selected') === 'true',
            left: r.left,
            right: r.right,
            top: r.top,
            width: r.width,
            height: r.height,
            background: getComputedStyle(el).backgroundColor,
          };
        }),
      );
    const add = await boxOf(ctx.page, '[data-testid="phone-tab-strip"] .tab-add');
    expectOnScreen(add, "the strip's +");
    await ctx.page.touchscreen.tap(add.left + add.width / 2, add.top + add.height / 2);
    let strip = [];
    await waitForCondition(
      ctx.page,
      async () => {
        strip = await stripTabs();
        // `@N`, not the placeholder shown until tmux confirms the window.
        return strip.length === 2 && strip[1].active && /^@\d+$/.test(strip[1].id);
      },
      15000,
      () => `+ on the strip to make a second tab, current (last: ${JSON.stringify(strip)})`,
    );
    // Two tabs fit side by side, however long their names.
    for (const [i, tab] of strip.entries()) {
      expectOnScreen(tab, `strip tab ${i + 1}`);
      expect(tab.top).toBeGreaterThanOrEqual(layout.strip.top - 1);
      expect(tab.top + tab.height).toBeLessThanOrEqual(layout.strip.top + layout.strip.height + 1);
      expect({ i, tall: tab.height >= 24 }).toEqual({ i, tall: true });
    }
    // A finger does not hover: the tap left no tooltip over the strip.
    expect(
      await ctx.page.evaluate(() => document.querySelector('[data-testid="tooltip"]') !== null),
    ).toBe(false);

    await ctx.page.touchscreen.tap(
      strip[0].left + strip[0].width / 2,
      strip[0].top + strip[0].height / 2,
    );
    await waitForCondition(
      ctx.page,
      async () => {
        strip = await stripTabs();
        return strip.length === 2 && strip[0].active && !strip[1].active;
      },
      15000,
      () => `a tap on the first tab of the strip to switch to it (last: ${JSON.stringify(strip)})`,
    );
    // The window it switched to is the one that ran the commands, still
    // rendered and still on screen — the last line it printed, not a tab that
    // switched to an empty grid.
    await waitForTerminalText(ctx.page, 'line-79', 15000);
    // The tapped tab is lit as the current tab is, by its colour alone: the
    // hover a tap leaves behind paints no background. Read once the line is
    // back, long after the background's transition would have ended.
    strip = await stripTabs();
    expect(strip[0].background).toBe('rgba(0, 0, 0, 0)');

    // 5. The tree lists the same tabs, each a thumb's height, and a tap on
    //    its second row switches the strip with it.
    const treeRows = () =>
      ctx.page.evaluate(() =>
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
    let rows = [];
    await waitForCondition(
      ctx.page,
      async () => {
        rows = await treeRows();
        return rows.length === 2 && rows[0].active;
      },
      15000,
      () => `the tree to list both tabs, the first current (last: ${JSON.stringify(rows)})`,
    );
    for (const [i, row] of rows.entries()) {
      expectOnScreen(row, `tree row ${i + 1}`);
      // A tap target below this is not reachable with a thumb.
      expect({ i, tall: row.height >= 18 }).toEqual({ i, tall: true });
    }
    await ctx.page.touchscreen.tap(
      rows[1].left + rows[1].width / 2,
      rows[1].top + rows[1].height / 2,
    );
    await waitForCondition(
      ctx.page,
      async () => {
        rows = await treeRows();
        strip = await stripTabs();
        return rows[1]?.active === true && strip[1]?.active === true;
      },
      15000,
      () =>
        `a tap on the tree's second row to switch to it, on the strip too (tree: ${JSON.stringify(rows)}, strip: ${JSON.stringify(strip)})`,
    );
  }, 240000);
});
