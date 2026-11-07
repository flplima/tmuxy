/**
 * Layout & Navigation E2E Tests (Pinned Terminal Dock & Tree Grid Order)
 */

const {
  sidebarShown,
  describeE2E,
  delay,
  focusPage,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  TMUXY_CLI,
  splitPaneKeyboard,
  openSidebarKeyboard,
  sendPrefixCommand,
  createWindowKeyboard,
  afterFrames,
  waitForCondition,
  waitForShellPrompt,
  waitForKeyboardFocus,
  cursorAnchorCenter,
  sampleCursorGlide,
  glidePositions,
  sampleSidebarToggle,
  jumpProblem,
} = require('./helpers/layout-helpers');
const { tmuxPanes, tmuxWindow } = require('./helpers/tmux-read');
const { tmuxExec } = require('./helpers/tmux-socket');

/** The session's dock window (`sidebar-right`), as tmux has it; null when it has none. */
function dockWindow(session) {
  const id = tmuxExec(`list-windows -t ${session} -F '#{window_id} #{@tmuxy-window-type}'`)
    .split('\n')
    .find((line) => line.endsWith(' sidebar-right'))
    ?.split(' ')[0];
  return id ? tmuxWindow(id) : null;
}

describeE2E('Scenario 6e: Pinned Terminal Dock (right sidebar)', {}, (ctx) => {
  test('prefix S docks a shell at the right edge → sized to its own column → typing reaches it → stays pinned across tabs → Esc reaches the shell, Ctrl+h blurs → the toggle hides it, prefix S reopens the same shell', async () => {
    await ctx.setupPage();

    const firstWindowId = await ctx.page.evaluate(() => window.app?.view().activeTabId);
    expect(firstWindowId).toMatch(/^@\d+$/);

    // Step 1: Open the dock via the real keybinding. First open also CREATES
    // its tmux window, so this covers the create path.
    await openSidebarKeyboard(ctx.page, 'right');

    // Step 2: The column docks against the right edge of the viewport, full
    // height — a flex sibling of the pane area, not an overlay.
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.right - window.innerWidth) <= 2 && r.width > 50 && r.height > 100;
        }),
      10000,
      'dock to sit against the right edge',
    );

    // Step 3: It is backed by a real `sidebar-right`-typed window with one pane,
    // and that window is NOT in the tab strip.
    await waitForCondition(
      ctx.page,
      async () => {
        const win = dockWindow(ctx.session.name);
        return !!win && tmuxPanes(win.id).length > 0;
      },
      20000,
      'a sidebar-right-typed window with a pane',
    );
    const tabStrip = await ctx.page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        // The column's window carries the fixed name `__sidebar-right` (the
        // create command targets it by that name) and tabs render `index:name`,
        // so a tab carrying that label is the column leaking into the strip.
        labels: tabs.map((t) => (t.textContent || '').trim()),
      };
    });
    tabStrip.dockWindowName = dockWindow(ctx.session.name)?.name;
    expect(tabStrip.dockWindowName).toBe('__sidebar-right');
    expect(tabStrip.labels.some((label) => label.includes('__sidebar'))).toBe(false);

    // Step 4: THE geometry contract. tmux sizes a `sidebar-right` window to that
    // column (sidebar_dock::size in tmuxy-core), not the viewport — otherwise
    // the shell wraps at a width the UI never draws. 35 cols wide, and the rows
    // the column holds in the sidebar font (@tmuxy-sidebar-rows, written by
    // the client): shorter rows than the pane grid's, so MORE of them than the
    // viewport has — the column is headerless, so it loses none.
    const dockSize = async () => {
      const win = dockWindow(ctx.session.name);
      const tab = await ctx.page.evaluate(() => window.app.view().activeTabId);
      return {
        pane: win ? tmuxPanes(win.id)[0] : null,
        rowsSent: win
          ? Number(tmuxExec(`display-message -p -t ${win.id} '#{@tmuxy-sidebar-rows}'`))
          : null,
        gridRows: tmuxWindow(tab).height,
      };
    };
    await waitForCondition(
      ctx.page,
      async () => {
        const size = await dockSize();
        return (
          size.pane?.width === 35 &&
          size.pane.height === size.rowsSent &&
          size.pane.height > size.gridRows
        );
      },
      20000,
      async () => `the column pane sized to its own column: ${JSON.stringify(await dockSize())}`,
    );

    // Step 5: Opening it took the keyboard, so typing lands in the dock — not
    // in the tab's active pane.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => (window.app?.view().keyboardTarget.kind === 'right') === true),
      10000,
      'dock to hold keyboard focus after opening',
    );
    // Click the dock's own terminal for focus, then re-establish CDP keyboard
    // focus (headless Chrome drops it across the DOM re-render the new column
    // causes) before typing character by character, the same cadence
    // typeInTerminal uses so the adapter's send-keys batching can't transpose.
    // Opening the dock handed it the keyboard; put the keyboard back in the
    // tiled pane first so the click below is a real focus change.
    await ctx.page.click('.pane-layout-item [role="log"]');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => (window.app?.view().keyboardTarget.kind === 'right') === false),
      5000,
      'the tiled pane to take the keyboard back before the glide',
    );
    // The cursor GLIDES into the dock: the smooth cursor overlay travels from
    // the tiled pane's cursor to the dock's over several frames rather than
    // reappearing there, and settles exactly on the dock's anchor.
    const glideIn = await sampleCursorGlide(ctx.page, () =>
      ctx.page.click('[data-testid="right-sidebar-content"] [role="log"]'),
    );
    expect(glideIn.frames.length).toBeGreaterThanOrEqual(4);
    expect(glidePositions(glideIn)).toEqual(
      expect.objectContaining({ distinct: expect.any(Number) }),
    );
    expect(
      glidePositions(glideIn).distinct >= 3 ? 'glided' : JSON.stringify(glidePositions(glideIn)),
    ).toBe('glided');
    expect(glideIn.settled).toEqual(
      await cursorAnchorCenter(ctx.page, '[data-testid="right-sidebar-content"]'),
    );
    await ctx.page.bringToFront();
    await waitForKeyboardFocus(ctx.page);
    for (const char of 'echo dock-typing-works') {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      20000,
      'the typed command to echo inside the dock',
    );
    // While the dock holds the keyboard it is the only surface drawing a
    // cursor: the tiled pane's block goes away (it no longer receives keys),
    // and the dock's sits inside the column, not off in its first row.
    const cursorsWhileDocked = await ctx.page.evaluate(() => {
      const dock = document.querySelector('[data-testid="right-sidebar-content"]');
      const d = dock.getBoundingClientRect();
      const inDock = [...dock.querySelectorAll('.terminal-cursor')].map((c) => {
        const r = c.getBoundingClientRect();
        return r.left >= d.left && r.right <= d.right && r.top >= d.top && r.bottom <= d.bottom;
      });
      const tiled = document.querySelectorAll('.pane-layout-item .terminal-cursor').length;
      return { inDock, tiled };
    });
    expect(cursorsWhileDocked).toEqual({ inDock: [true], tiled: 0 });

    // Step 6: The point of the feature — it stays put when the user changes
    // tabs, because its pane lives in its own window.
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(() => window.app?.view().activeTabId);
        return active && active !== firstWindowId;
      },
      8000,
      'second window to become active',
    );
    const stillDockedOnNewTab = await ctx.page.evaluate(() => {
      const el = document.querySelector('[data-testid="right-sidebar-content"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        visible: r.width > 50 && r.height > 100,
        keptOutput: (el.textContent || '').includes('dock-typing-works'),
      };
    });
    expect(stillDockedOnNewTab).toEqual({ visible: true, keptOutput: true });

    // Step 7: Escape is an ordinary key inside the dock — a program pinned
    // there (vim, fzf) must receive it — so it neither blurs nor closes the
    // column. Ctrl+h is what hands the keyboard back to the panes.
    await focusPage(ctx.page);
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => (window.app?.view().keyboardTarget.kind === 'right') === true),
      5000,
      'dock focused after a click',
    );
    await ctx.page.keyboard.press('Escape');
    // The key is handled in the page: had Escape moved the focus, it would
    // show within a frame or two.
    await afterFrames(ctx.page);
    const stillFocusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.view().keyboardTarget.kind === 'right',
    );
    expect(stillFocusedAfterEscape).toBe(true);
    // ...and glides back out to the tiled pane's cursor when Ctrl+h hands the
    // keyboard back.
    const glideOut = await sampleCursorGlide(ctx.page, async () => {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('h');
      await ctx.page.keyboard.up('Control');
    });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => (window.app?.view().keyboardTarget.kind === 'right') === false),
      5000,
      'the dock let go of the keyboard after Ctrl+h',
    );
    expect(
      glidePositions(glideOut).distinct >= 3 ? 'glided' : JSON.stringify(glidePositions(glideOut)),
    ).toBe('glided');
    expect(glideOut.settled).toEqual(await cursorAnchorCenter(ctx.page, '.pane-layout-item'));
    // The keyboard is back in the panes: the tiled pane draws its cursor again
    // and the dock draws none.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () =>
            document.querySelectorAll('.pane-layout-item .terminal-cursor').length === 1 &&
            document.querySelectorAll('[data-testid="right-sidebar-content"] .terminal-cursor')
              .length === 0,
        ),
      5000,
      'the cursor to move back from the dock to the tiled pane',
    );
    const openAfterBlur = await ctx.page.evaluate(
      () => !!document.querySelector('[data-testid="right-sidebar-content"]'),
    );
    expect(openAfterBlur).toBe(true);

    // Step 8: the header toggle HIDES the column but keeps the shell alive —
    // prefix S reopens the same terminal, scrollback and all. Both ways it is
    // instant: the column and the pane container go straight from one width
    // to the other, with no frame in between.
    const dockWidth = await ctx.page.evaluate(() =>
      Math.round(
        document.querySelector('[data-testid="right-sidebar-content"]').getBoundingClientRect()
          .width,
      ),
    );
    const closing = await sampleSidebarToggle(
      ctx.page,
      () => ctx.page.click('button[aria-label="Toggle terminal sidebar"]'),
      '[data-testid="right-sidebar-content"]',
    );
    expect(jumpProblem(closing.column)).toBeNull();
    expect(jumpProblem(closing.container)).toBeNull();
    expect(closing.column[0]).toBe(dockWidth);
    expect(closing.column[closing.column.length - 1]).toBe(0);
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 10000, polling: 100 },
    );
    const windowSurvivedHide = dockWindow(ctx.session.name) !== null;
    expect(windowSurvivedHide).toBe(true);

    const opening = await sampleSidebarToggle(
      ctx.page,
      () => sendPrefixCommand(ctx.page, 'S', { shift: true }),
      '[data-testid="right-sidebar-content"]',
    );
    expect(jumpProblem(opening.column)).toBeNull();
    expect(jumpProblem(opening.container)).toBeNull();
    expect(opening.column[opening.column.length - 1]).toBe(dockWidth);
    await ctx.page.waitForSelector('[data-testid="right-sidebar-content"]', { timeout: 10000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('[data-testid="right-sidebar-content"]');
          return !!el && (el.textContent || '').includes('dock-typing-works');
        }),
      10000,
      'the same shell (with its scrollback) to come back on reopen',
    );

    // Cleanup: kill the pinned shell the way a user would — `exit` inside it —
    // so the shared tmux server is left clean for the next test in the file.
    // The column has no kill button: its toggle only hides it, and the shell
    // going away is what retracts the column (see appMachine's sidebar
    // lifecycle).
    // The Escape from step 7 reached this shell; in a vi-mode zsh that leaves
    // the line editor in command mode, where `exit` would not be typed. Ctrl+C
    // aborts the line and starts a fresh one in insert mode under either keymap.
    await ctx.page.click('[data-testid="sidebar-title-right"] .sidebar-title-text');
    // Keys reach the shell in the order pressed; no beat between them.
    await ctx.page.keyboard.press('Control+c');
    await ctx.page.keyboard.type('exit');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 15000, polling: 100 },
    );
  }, 180000);
});

describeE2E('Scenario 6l: The tree lists panes in grid order', {}, (ctx) => {
  test('panes read left to right as in the grid, and the list follows a swap', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Two panes side by side.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);

    const treeOpen = () => sidebarShown(ctx.page, 'left');
    if (!(await treeOpen())) await openSidebarKeyboard(ctx.page, 'left');
    await waitForCondition(ctx.page, treeOpen, 15000, 'the tree to open');

    // What the grid shows, left to right, and what the tree lists.
    const order = () =>
      ctx.page.evaluate(() => {
        const activeWindowId = window.app.view().activeTabId;
        // The grid's panes as drawn, top to bottom, left to right.
        const grid = [
          ...document.querySelectorAll('.pane-container .pane-layout-item[data-pane-id]'),
        ]
          .filter((el) => !el.closest('.pane-window-hidden'))
          .map((el) => ({ id: el.dataset.paneId, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .sort((a, b) => Math.round(a.r.top - b.r.top) || a.r.left - b.r.left)
          .map(({ id }) => id);
        const tree = [
          ...document.querySelectorAll(
            `[data-testid="tree-tab-${activeWindowId}"] + .sidebar-tree-children .sidebar-tree-pane`,
          ),
        ]
          .map((el) => el.getAttribute('data-pane-id'))
          .filter((id) => grid.includes(id));
        return { grid, tree };
      });
    const waitForTreeInGridOrder = (what) =>
      waitForCondition(
        ctx.page,
        async () => {
          const { grid, tree } = await order();
          return grid.length === 2 && JSON.stringify(grid) === JSON.stringify(tree);
        },
        15000,
        async () => `${what} (now ${JSON.stringify(await order())})`,
      );
    await waitForTreeInGridOrder('the tree to list the panes left to right');
    const before = (await order()).grid;

    // The user swaps them: the list follows the grid, not the panes' ids.
    await typeInTerminal(ctx.page, `'${TMUXY_CLI}' pane swap ${before[0]} ${before[1]}`);
    await pressEnter(ctx.page);
    await waitForCondition(
      ctx.page,
      async () => JSON.stringify((await order()).grid) === JSON.stringify([...before].reverse()),
      15000,
      'the swap to land in the grid',
    );
    await waitForTreeInGridOrder('the tree to follow the swap');
  }, 120000);
});
