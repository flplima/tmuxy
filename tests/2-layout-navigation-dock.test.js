/**
 * Layout & Navigation E2E Tests (Pinned Terminal Dock & Tree Grid Order)
 */

describe('Scenario 6e: Pinned Terminal Dock (right sidebar)', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix S docks a shell at the right edge → sized to its own column → typing reaches it → stays pinned across tabs → Esc reaches the shell, Ctrl+h blurs → the toggle hides it, prefix S reopens the same shell', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);

    // Step 1: Open the dock via the real keybinding. First open also CREATES
    // its tmux window, so this covers the create path.
    await openSidebarKeyboard(ctx.page, 'right', { fixed: true });

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
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          return !!win && ctxState.panes.some((p) => p.windowId === win.id);
        }),
      20000,
      'a sidebar-right-typed window with a pane',
    );
    const tabStrip = await ctx.page.evaluate(() => {
      const win = window.app
        ?.getSnapshot()
        ?.context?.windows?.find((w) => w.windowType === 'sidebar-right');
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        // The column's window carries the fixed name `__sidebar-right` (the
        // create command targets it by that name) and tabs render `index:name`,
        // so a tab carrying that label is the column leaking into the strip.
        labels: tabs.map((t) => (t.textContent || '').trim()),
        dockWindowName: win?.name,
      };
    });
    expect(tabStrip.dockWindowName).toBe('__sidebar-right');
    expect(tabStrip.labels.some((label) => label.includes('__sidebar'))).toBe(false);

    // Step 4: THE geometry contract. tmux sizes a `sidebar-right` window to that
    // column (sidebar_dock::size in tmuxy-core), not the viewport — otherwise
    // the shell wraps at a width the UI never draws. 35 cols wide, and the rows
    // the column holds in the sidebar font (@tmuxy-sidebar-rows, written by
    // the client): shorter rows than the pane grid's, so MORE of them than the
    // viewport has — the column is headerless, so it loses none.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          const sent = ctxState?.dockRowsSent;
          return (
            pane?.width === 35 &&
            sent?.windowId === win?.id &&
            pane?.height === sent.rows &&
            pane.height > ctxState.targetRows
          );
        }),
      20000,
      async () =>
        ctx.page.evaluate(() => {
          const ctxState = window.app?.getSnapshot()?.context;
          const win = ctxState?.windows?.find((w) => w.windowType === 'sidebar-right');
          const pane = ctxState?.panes?.find((p) => p.windowId === win?.id);
          return `column pane sized to its own column (got ${pane?.width}x${pane?.height}, want 35x${ctxState?.dockRowsSent?.rows}, viewport rows ${ctxState?.targetRows})`;
        }),
    );

    // Step 5: Opening it took the keyboard, so typing lands in the dock — not
    // in the tab's active pane.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
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
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === false),
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
    await delay(200);
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
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
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
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === true),
      5000,
      'dock focused after a click',
    );
    await ctx.page.keyboard.press('Escape');
    // The key is handled in the page: had Escape moved the focus, it would
    // show within a frame or two.
    await afterFrames(ctx.page);
    const stillFocusedAfterEscape = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.rightSidebarFocused,
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
        ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.rightSidebarFocused === false),
      5000,
      'rightSidebarFocused cleared after Ctrl+h',
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
    // prefix S reopens the same terminal, scrollback and all. Both ways the
    // column SLIDES: its width eases to zero and back, and the pane
    // container's width eases with it, rather than either jumping between
    // the two layouts.
    const dockWidth = await ctx.page.evaluate(() =>
      Math.round(
        document.querySelector('[data-testid="right-sidebar-content"]').getBoundingClientRect()
          .width,
      ),
    );
    const closing = await sampleSidebarSlide(
      ctx.page,
      () => ctx.page.click('button[aria-label="Toggle terminal sidebar"]'),
      '[data-testid="right-sidebar-content"]',
    );
    expect(slideProblem(closing.column, -1)).toBeNull();
    expect(slideProblem(closing.container, +1)).toBeNull();
    expect(closing.column[0]).toBe(dockWidth);
    expect(closing.column[closing.column.length - 1]).toBe(0);
    await ctx.page.waitForFunction(
      () => !document.querySelector('[data-testid="right-sidebar-content"]'),
      { timeout: 10000, polling: 100 },
    );
    const windowSurvivedHide = await ctx.page.evaluate(() =>
      window.app?.getSnapshot()?.context?.windows?.some((w) => w.windowType === 'sidebar-right'),
    );
    expect(windowSurvivedHide).toBe(true);

    const opening = await sampleSidebarSlide(
      ctx.page,
      () => sendPrefixCommand(ctx.page, 'S', { shift: true }),
      '[data-testid="right-sidebar-content"]',
    );
    expect(slideProblem(opening.column, +1)).toBeNull();
    expect(slideProblem(opening.container, -1)).toBeNull();
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

describe('Scenario 6l: The tree lists panes in grid order', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('panes read left to right as in the grid, and the list follows a swap', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Two panes side by side.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);

    const treeOpen = () =>
      ctx.page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === true);
    if (!(await treeOpen())) await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await waitForCondition(ctx.page, treeOpen, 15000, 'the tree to open');

    // What the grid shows, left to right, and what the tree lists.
    const order = () =>
      ctx.page.evaluate(() => {
        const { activeWindowId, panes } = window.app.getSnapshot().context;
        const grid = panes
          .filter((p) => p.windowId === activeWindowId)
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((p) => p.tmuxId);
        const tree = [
          ...document.querySelectorAll(
            `[data-testid="tree-tab-${activeWindowId}"] ~ .sidebar-tree-pane`,
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
