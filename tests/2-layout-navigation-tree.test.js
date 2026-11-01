/**
 * Layout & Navigation E2E Tests (Sidebar Tree View)
 */

const fs = require('fs');
const {
  createTestContext,
  runCommand,
  waitForWindowCount,
  openSidebarKeyboard,
  createWindowKeyboard,
  afterFrames,
  waitForCondition,
  waitForKeyboardTarget,
} = require('./helpers/layout-helpers');

// ==================== Scenario 6d: Sidebar Tree View ====================

describe('Scenario 6d: Sidebar Tree View', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix t opens fixed sidebar → tree shows tabs/panes → focus + Enter activates a tab and hands it the keyboard → l blurs → q closes', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The first window — we'll switch back to it via the tree later. Captured
    // before creating a second window, so it's the lowest-index tab (row 0).
    const firstWindowId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activeWindowId,
    );
    expect(firstWindowId).toMatch(/^@\d+$/);
    const firstPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.activePaneId,
    );
    expect(firstPaneId).toMatch(/^%\d+$/);

    // A pane sitting inside a git checkout: the tree decorates its row with
    // the branch. The repo is a throwaway created here, so the badge can only
    // come from discovering this pane's cwd — not from the tmuxy checkout.
    const os = require('os');
    const path = require('path');
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-tree-git-'));
    const branch = 'tree-badge-branch';
    // The user makes the checkout in the pane, as they would (typed by the
    // harness as the operator: `tmuxy run` refuses input into a pane).
    await ctx.session.runAsOperator(
      `send-keys -t ${firstPaneId} 'cd ${repoDir} && git init -q -b ${branch}' Enter`,
    );
    await waitForCondition(
      ctx.page,
      async () => {
        if (!fs.existsSync(path.join(repoDir, '.git', 'HEAD'))) return false;
        const out = String(
          await ctx.session.query("list-panes -a -F '#{pane_id}\t#{pane_current_path}'"),
        );
        const cwd = out
          .split('\n')
          .map((l) => l.split('\t'))
          .find(([id]) => id === firstPaneId)?.[1];
        return Boolean(cwd) && fs.realpathSync(cwd) === fs.realpathSync(repoDir);
      },
      8000,
      'the pane to sit inside the throwaway repo',
    );

    // Setup (not the feature under test): a second window so the tree lists
    // more than one tab and an activation switch is observable.
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

    // A pane whose title outgrows the column. A pane row is two lines — the
    // process on the first, the title on the second — and it is the TITLE line
    // that has to truncate rather than spill past the column's edge.
    const longTitle = 'a very long pane title that certainly needs truncating in this tree';
    // The shell may set the title itself at every prompt (zsh and fish
    // configs commonly do, over OSC 2), which would overwrite this one before
    // the tree draws it. `allow-set-title off` keeps the title the test set
    // (`-q`: tmux 3.2 has no such option). An option is the user's to set,
    // never `tmuxy run`'s, so the harness sets it as the operator.
    await ctx.session.runAsOperator(`set-option -q -p -t ${ctx.session.name} allow-set-title off`);
    await ctx.session.runCommand(`select-pane -t ${ctx.session.name} -T '${longTitle}'`);

    // Step 1: Open the sidebar via the real keybinding (prefix s).
    await openSidebarKeyboard(ctx.page, 'left');

    // Step 2: The FIXED sidebar column appears docked at the left edge (it is
    // a flex sibling of the pane area, not an overlay — panes reflow beside it).
    await ctx.page.waitForSelector('.sidebar-column-left', { timeout: 20000 });
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.querySelector('.sidebar-column-left');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.left) <= 2 && r.width > 50 && r.height > 100;
        }),
      8000,
      'fixed sidebar to dock at the left edge',
    );

    // Step 3: The tree rendered real rows — both windows' tabs are listed.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length >= 2,
        ),
      20000,
      'tree rows to render in the sidebar',
    );
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate((title) => {
          const titleLine = [
            ...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-title'),
          ].find((el) => el.textContent.includes(title.slice(0, 20)));
          if (!titleLine) return false;
          // The title really is the SECOND line: the process line sits above
          // it, in the same label column.
          const row = titleLine.closest('.sidebar-tree-pane');
          const processLine = row.querySelector('.sidebar-tree-line');
          if (!processLine) return false;
          const above = processLine.getBoundingClientRect();
          const column = document.querySelector('.sidebar-column-left').getBoundingClientRect();
          const r = titleLine.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(titleLine).lineHeight);
          // One line, really cut rather than spilling past the column, still
          // inside it on every side, and under the process line.
          return (
            Math.round(r.height / lineHeight) === 1 &&
            titleLine.scrollWidth > titleLine.clientWidth &&
            r.top >= above.bottom - 1 &&
            r.left >= column.left &&
            r.right <= column.right &&
            r.bottom <= column.bottom
          );
        }, longTitle),
      8000,
      // On failure, what the tree drew and what the panes report IS the
      // diagnosis: a missing title and a title that did not truncate look the
      // same from the outside.
      async () =>
        `the long pane title to truncate onto its own line in the tree\ntree titles: ${await ctx.page.evaluate(
          () =>
            JSON.stringify(
              [...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-title')].map((el) => [
                el.textContent,
                el.scrollWidth,
                el.clientWidth,
                Math.round(el.getBoundingClientRect().height),
              ]),
            ),
        )}\npanes: ${await ctx.page.evaluate(() =>
          JSON.stringify(
            window.app.getSnapshot().context.panes.map((p) => [p.tmuxId, p.title, p.command]),
          ),
        )}`,
    );

    // The pane inside the repo shows its branch, drawn inside the column, and
    // no other row does — the other panes sit in whatever checkout the server
    // was started from, never in this throwaway one.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          ({ paneId, branch }) => {
            const badge = document.querySelector(
              `[data-testid="tree-pane-${paneId}"] .sidebar-tree-git`,
            );
            if (!badge || badge.textContent !== branch) return false;
            const column = document.querySelector('.sidebar-column-left').getBoundingClientRect();
            const r = badge.getBoundingClientRect();
            return r.width > 0 && r.left >= column.left && r.right <= column.right;
          },
          { paneId: firstPaneId, branch },
        ),
      25000,
      'the branch badge on the pane inside the repo',
    );
    const rowsOnBranch = await ctx.page.evaluate(
      (name) =>
        [...document.querySelectorAll('.sidebar-tree-pane .sidebar-tree-git')].filter(
          (el) => el.textContent === name,
        ).length,
      branch,
    );
    expect(rowsOnBranch).toBe(1);
    fs.rmSync(repoDir, { recursive: true, force: true });

    // Step 4: Focus the sidebar (click) so keys route to the tree.
    //
    // Click the column's TITLE in the app header, not the column itself:
    // Playwright clicks an element's CENTRE, and the centre of the column is a
    // tree row. Every row activates on click, so focusing that way could land
    // on a session row and fire SWITCH_SESSION — silently moving the whole
    // client to another session mid-test. The title focuses the column and
    // does nothing else.
    const sidebarFocused = () =>
      ctx.page.evaluate(() => window.app?.getSnapshot()?.context?.leftSidebarFocused);
    const focusTree = async (label) => {
      await ctx.page.click('[data-testid="sidebar-title-left"] .sidebar-title-text');
      await waitForCondition(ctx.page, async () => (await sidebarFocused()) === true, 5000, label);
    };
    await focusTree('leftSidebarFocused set after click');

    // The keyboard actor hears UPDATE_LEFT_SIDEBAR_FOCUSED by message, after
    // the context has it: wait until it says the tree holds the keys.
    await waitForKeyboardTarget(ctx.page, 'left-sidebar');
    await ctx.page.bringToFront();

    // Step 5: Move the selection onto the FIRST window's tab row, then Enter
    // activates it → the active window switches back to the first window.
    //
    // Target the row by window id rather than by index: the tree inserts a
    // session header row whenever the socket hosts more than one session (which
    // it does under test — the server keeps its own session alongside the one
    // the test creates), so row 0 is not necessarily the first tab.
    //
    // Navigate top-down rather than walking up from wherever the cursor starts.
    // The tree's default selection is the active pane's row, but it falls back
    // to row 0 when that row isn't found — and row 0 sits ABOVE the target, so
    // pressing only `k` could never reach it.
    // Wait for the first tab's row first: the tree draws the session's tabs
    // from the windows the client holds, so it has none to select until the
    // client has the state.
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          (id) => !!document.querySelector(`[data-testid="tree-tab-${id}"]`),
          firstWindowId,
        ),
      15000,
      async () => {
        const s = await ctx.page.evaluate(() => {
          const c = window.app?.getSnapshot()?.context;
          return {
            url: location.href,
            sessionName: c?.sessionName,
            sessions: (c?.sessions || []).map((x) => x.sessionName),
            windows: (c?.windows || []).map((w) => w.id),
            rows: Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
              (r) => r.getAttribute('data-testid'),
            ),
          };
        });
        return `live tab row for ${firstWindowId}; ctxSession=${ctx.session.name}; state=${JSON.stringify(s)}`;
      },
    );

    const firstTabSelected = () =>
      ctx.page.evaluate((id) => {
        const row = document.querySelector(`.sidebar-tree [data-testid="tree-tab-${id}"]`);
        return !!row && row.classList.contains('is-selected');
      }, firstWindowId);

    const rowCount = await ctx.page.evaluate(
      () => document.querySelectorAll('.sidebar-tree [role="treeitem"]').length,
    );
    // `k` clamps at row 0, so this parks the cursor at the top whatever it was.
    for (let i = 0; i < rowCount; i++) {
      await ctx.page.keyboard.press('k');
    }
    for (let i = 0; i < rowCount && !(await firstTabSelected()); i++) {
      await ctx.page.keyboard.press('j');
    }
    await waitForCondition(ctx.page, firstTabSelected, 5000, async () => {
      const tree = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.sidebar-tree [role="treeitem"]')).map(
          (r) =>
            `${r.className.includes('is-selected') ? '>' : ' '} ${r.getAttribute('data-testid')}`,
        ),
      );
      return `selection to reach the first window's tab row (${firstWindowId})\n  tree:\n    ${tree.join('\n    ')}`;
    });
    await ctx.page.keyboard.press('Enter');
    await waitForCondition(
      ctx.page,
      async () => {
        const active = await ctx.page.evaluate(
          () => window.app?.getSnapshot()?.context?.activeWindowId,
        );
        return active === firstWindowId;
      },
      10000,
      'tree Enter to activate the first window',
    );
    // Activating a row hands the keyboard to what it picked, the tab's pane.
    await waitForCondition(
      ctx.page,
      async () => (await sidebarFocused()) === false,
      5000,
      'the tree to hand the keyboard to the tab it activated',
    );

    // Step 6: `l` (nav right, out of the column) blurs the tree — the column
    // stays open, focus returns to the panes. Escape is deliberately not a
    // sidebar key, so it must leave the focus where it is.
    await focusTree('tree focused again before Escape');
    await ctx.page.keyboard.press('Escape');
    await afterFrames(ctx.page);
    expect(await sidebarFocused()).toBe(true);
    await ctx.page.keyboard.press('l');
    await waitForCondition(
      ctx.page,
      async () => (await sidebarFocused()) === false,
      5000,
      'leftSidebarFocused cleared after l',
    );
    const stillOpen = await ctx.page.evaluate(() => {
      const el = document.querySelector('.sidebar-column-left');
      return !!el && el.getBoundingClientRect().width > 50;
    });
    expect(stillOpen).toBe(true);

    // The header toggle reflects the open state.
    const pressedWhileOpen = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedWhileOpen).toBe('true');

    // Step 7: `q` from inside the focused tree closes the sidebar — the
    // column is removed and the toggle returns to its unpressed state.
    await focusTree('tree focused again before q');
    await ctx.page.keyboard.press('q');
    await ctx.page.waitForFunction(() => !document.querySelector('.sidebar-column-left'), {
      timeout: 10000,
      polling: 100,
    });
    const pressedAfterClose = await ctx.page.evaluate(() =>
      document.querySelector('.sidebar-toggle-left')?.getAttribute('aria-pressed'),
    );
    expect(pressedAfterClose).toBe('false');

    // Step 8: Ctrl+h at the grid's left edge has nowhere to go with the tree
    // closed — the hidden column's window is still there, and it must not
    // open it. The command typed after it lands in the pane, which is also
    // what says the nav round trip has finished.
    await ctx.page.keyboard.press('Control+h');
    await runCommand(ctx.page, 'echo AFTER_NAV_LEFT', 'AFTER_NAV_LEFT');
    const afterNav = await ctx.page.evaluate(() => ({
      column: !!document.querySelector('.sidebar-column-left'),
      open: window.app.getSnapshot().context.leftSidebarOpen,
      focused: window.app.getSnapshot().context.leftSidebarFocused,
    }));
    expect(afterNav).toEqual({ column: false, open: false, focused: false });
  }, 180000);
});
