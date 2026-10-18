/**
 * Layout & Navigation E2E Tests (PANE/TAB Modes, Agent Tree State & Tree Drag)
 */

const fs = require('fs');
const {
  createTestContext,
  waitForPaneCount,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  TMUXY_CLI,
  splitPaneKeyboard,
  navigatePaneKeyboard,
  sendPrefixCommand,
  openSidebarKeyboard,
  createWindowKeyboard,
  waitForShellPrompt,
  waitForCondition,
} = require('./helpers/layout-helpers');

// ==================== Scenario 11b: Rename field keeps its paste ====================

describe('Scenario 11c: PANE and TAB modes, the sidebar keys and the keys view', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('prefix p: the PANE chip, x closes panes until esc → prefix t: the TAB chip, c opens a tab → prefix s overlays the tree, prefix s again docks it → prefix S S docks the terminal → prefix ? lists PANE', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // What the status line shows: its mode, the chip as drawn, and whether
    // the host and session are on screen.
    const statusLine = () =>
      page.evaluate(() => {
        const hints = document.querySelector('[data-testid="statusline-hints"]');
        const chip = hints?.querySelector('.statusline-mode');
        const chipBox = chip?.getBoundingClientRect();
        const right = document.querySelector('.tmux-statusline-right')?.getBoundingClientRect();
        return {
          mode: hints?.getAttribute('data-key-mode') ?? null,
          chip: chip?.textContent ?? null,
          chipVisible: !!chipBox && chipBox.width > 0 && chipBox.height > 0,
          hostShown: !!right && right.width > 0,
        };
      });

    // PANE mode: sticky, so x twice closes two panes without the prefix again.
    await splitPaneKeyboard(page, 'vertical');
    await splitPaneKeyboard(page, 'horizontal');
    await waitForPaneCount(page, 3);
    await sendPrefixCommand(page, 'p');
    await waitForCondition(
      page,
      async () => (await statusLine()).chip === 'PANE',
      15000,
      'the PANE chip',
    );
    expect(await statusLine()).toMatchObject({ chipVisible: true, hostShown: false });
    await page.keyboard.press('x');
    await waitForPaneCount(page, 2);
    await page.keyboard.press('x');
    await waitForPaneCount(page, 1);
    expect((await statusLine()).chip).toBe('PANE');
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => {
        const line = await statusLine();
        return line.mode === 'normal' && line.hostShown;
      },
      15000,
      'the normal line, host and session back',
    );

    // TAB mode: c opens a tab and the mode stays.
    await sendPrefixCommand(page, 't');
    await waitForCondition(
      page,
      async () => (await statusLine()).chip === 'TAB',
      15000,
      'the TAB chip',
    );
    await page.keyboard.press('c');
    await waitForWindowCount(page, 2);
    expect((await statusLine()).chip).toBe('TAB');
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      async () => (await statusLine()).mode === 'normal',
      15000,
      'TAB mode to end',
    );

    // A column, and the grid of the tab in view.
    const column = (side) =>
      page.evaluate((s) => {
        const el = document.querySelector(`.sidebar-column-${s}`);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        const grid = [...document.querySelectorAll('.pane-layout-item')]
          .filter((p) => !p.classList.contains('pane-window-hidden'))
          .map((p) => p.getBoundingClientRect());
        return {
          overlay: el.classList.contains('is-overlay'),
          left: box.left,
          right: box.right,
          width: box.width,
          gridLeft: Math.min(...grid.map((g) => g.left)),
          gridRight: Math.max(...grid.map((g) => g.right)),
        };
      }, side);

    // prefix s: the tree opens over the panes.
    await openSidebarKeyboard(page, 'left');
    await waitForCondition(
      page,
      async () => {
        const c = await column('left');
        return c !== null && c.overlay && c.width > 50 && c.gridLeft < c.right - 1;
      },
      15000,
      'the tree overlaying the panes',
    );
    // prefix s on the open column: it docks, and the grid moves out from under it.
    await openSidebarKeyboard(page, 'left');
    await waitForCondition(
      page,
      async () => {
        const c = await column('left');
        return c !== null && !c.overlay && c.gridLeft >= c.right - 1;
      },
      15000,
      async () => `the tree docked beside the grid (${JSON.stringify(await column('left'))})`,
    );

    // prefix S S: the terminal opens and docks at once, the grid ending where it starts.
    await openSidebarKeyboard(page, 'right', { fixed: true });
    await waitForCondition(
      page,
      async () => {
        const c = await column('right');
        return c !== null && !c.overlay && c.width > 50 && c.gridRight <= c.left + 1;
      },
      20000,
      async () => `the terminal docked beside the grid (${JSON.stringify(await column('right'))})`,
    );

    // prefix ?: every key, table by table; esc closes it.
    await sendPrefixCommand(page, '?', { shift: true });
    await waitForCondition(
      page,
      () =>
        page.evaluate(() => {
          const view = document.querySelector('[data-testid="keys-view"]');
          const box = view?.getBoundingClientRect();
          return !!box && box.width > 0 && /PANE/.test(view.textContent);
        }),
      15000,
      'the keys view listing the PANE table',
    );
    await page.keyboard.press('Escape');
    await waitForCondition(
      page,
      () => page.evaluate(() => !document.querySelector('[data-testid="keys-view"]')),
      15000,
      'the keys view to close',
    );
  }, 180000);
});

describe('Scenario 6k: A coding agent’s state on its tree row', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('an agent’s hooks show it working → it finishes while the user is in another pane → unread → the user looks → idle', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);
    // Two panes: the agent's on top, the one the user moves to below.
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    const activePane = () => ctx.page.evaluate(() => window.app.getSnapshot().context.activePaneId);
    const otherPane = await activePane();
    await navigatePaneKeyboard(ctx.page, 'up');
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) !== otherPane,
      10000,
      'the top pane to be active',
    );
    const agentPane = await activePane();

    // A stand-in for an agent: it runs exactly the hook commands
    // `tmuxy agent install` puts in Claude Code's settings — a prompt, then
    // the turn ending — and ends its turn when the test says so.
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-agent-'));
    const go = path.join(dir, 'go');
    const hook = (event) => `echo '{}' | '${TMUXY_CLI}' agent hook claude ${event}`;
    await typeInTerminal(
      ctx.page,
      `${hook('UserPromptSubmit')}; until [ -e '${go}' ]; do sleep 0.2; done; ${hook('Stop')}`,
    );
    await pressEnter(ctx.page);

    // The user moves on to the other pane.
    await navigatePaneKeyboard(ctx.page, 'down');
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) === otherPane,
      10000,
      'the other pane to be active',
    );
    // Open the tree with its key — unless an earlier test left it open, when
    // the same key would free it to overlay the panes.
    const treeOpen = () =>
      ctx.page.evaluate(() => window.app.getSnapshot().context.leftSidebarOpen === true);
    if (!(await treeOpen())) await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await waitForCondition(ctx.page, treeOpen, 15000, 'the tree to open');

    // A state mark wherever it is drawn: the tree row and the pane's header
    // (in the icon's place), and the tab (in its number's). Idle draws none.
    const mark = (selector) =>
      ctx.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          state: [...el.classList].find((c) => c.startsWith('is-'))?.slice(3) ?? null,
          text: el.textContent,
          visible: r.width > 0 && r.height > 0 && r.left >= 0,
        };
      }, selector);
    const rowMark = `[data-testid="tree-pane-${agentPane}"] .sidebar-tree-state`;
    const tabMark = '.tab-name-active .tab-mark';
    const headerMark = `[data-pane-tab="${agentPane}"] .pane-tab-icon`;
    const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/;
    const waitForMark = (selector, expected, what) =>
      waitForCondition(
        ctx.page,
        async () => {
          const now = await mark(selector);
          // An idle pane row draws no mark at all — its process icon is back.
          if (!now) return expected.state === null && expected.text === undefined;
          if (now.state !== expected.state) return false;
          if (expected.state && !now.visible) return false;
          if (expected.text instanceof RegExp) return expected.text.test(now.text);
          return expected.text === undefined || now.text === expected.text;
        },
        20000,
        async () =>
          `${what} to be ${expected.state ?? 'idle'} (now ${JSON.stringify(await mark(selector))})`,
      );

    // Working: the same text spinner on the tree row, the tab (in place of its
    // number) and the pane's header (in place of its icon) — and it turns.
    await waitForMark(rowMark, { state: 'working', text: SPINNER }, 'the tree row');
    await waitForMark(tabMark, { state: 'working', text: SPINNER }, 'the tab');
    await waitForMark(headerMark, { state: 'working', text: SPINNER }, 'the pane header');
    const frames = new Set();
    await waitForCondition(
      ctx.page,
      async () => {
        frames.add((await mark(tabMark))?.text);
        return frames.size > 1;
      },
      5000,
      async () => `the spinner to turn (saw ${JSON.stringify([...frames])})`,
    );

    // The agent finishes while the user is in the other pane: unread.
    fs.writeFileSync(go, '');
    await waitForMark(rowMark, { state: 'unread', text: '●' }, 'the tree row');
    await waitForMark(tabMark, { state: 'unread', text: '●' }, 'the tab');

    // The user sees the mark and clicks the row: seen, so idle — no mark on
    // the row, and the tab shows its number again.
    await ctx.page.click(`[data-testid="tree-pane-${agentPane}"]`);
    await waitForCondition(
      ctx.page,
      async () => (await activePane()) === agentPane,
      10000,
      'the agent’s pane to be active again',
    );
    await waitForMark(rowMark, { state: null }, 'the tree row');
    await waitForMark(tabMark, { state: null, text: '➊' }, 'the tab');
  }, 120000);
});

describe('Scenario 6m: Dragging in the tree moves panes between tabs and reorders tabs', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  const tabRows = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-tree-tab[data-window-id]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.windowId, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
  /** The tree's rows top to bottom: `tab:@n` and `pane:%n`. */
  const treeOrder = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidebar-tree [role="treeitem"]')].map((el) =>
        el.dataset.windowId ? `tab:${el.dataset.windowId}` : `pane:${el.dataset.paneId}`,
      ),
    );

  test('a pane row dropped on another tab joins it there → a tab row dragged above another reorders the strip and the tree alike', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // Tab 1 with two panes (so moving one does not close it), then tab 2.
    const firstWindowId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activeWindowId,
    );
    await splitPaneKeyboard(ctx.page, 'horizontal');
    await waitForPaneCount(ctx.page, 2);
    const movedPaneId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activePaneId,
    );
    await createWindowKeyboard(ctx.page);
    await waitForWindowCount(ctx.page, 2);
    const secondWindowId = await ctx.page.evaluate(
      () => window.app.getSnapshot().context.activeWindowId,
    );
    expect(secondWindowId).not.toBe(firstWindowId);

    await openSidebarKeyboard(ctx.page, 'left', { fixed: true });
    await ctx.page.waitForSelector(`[data-testid="tree-tab-${secondWindowId}"]`, {
      timeout: 20000,
    });
    await ctx.page.waitForSelector(`[data-testid="tree-pane-${movedPaneId}"]`, { timeout: 20000 });

    // Step 1: drag the pane row onto the other tab's row. The browser's own
    // drag-and-drop, as the row is `draggable`.
    await ctx.page.dragAndDrop(
      `[data-testid="tree-pane-${movedPaneId}"]`,
      `[data-testid="tree-tab-${secondWindowId}"]`,
    );
    // The tree lists it under tab 2 — and keeps it there while tmux answers.
    await waitForCondition(
      ctx.page,
      async () => {
        const order = await treeOrder(ctx.page);
        const tab = order.indexOf(`tab:${secondWindowId}`);
        const pane = order.indexOf(`pane:${movedPaneId}`);
        return (
          tab !== -1 && pane > tab && !order.slice(tab + 1, pane).some((r) => r.startsWith('tab:'))
        );
      },
      10000,
      'the tree to list the dropped pane under the other tab',
    );
    // tmux moved it, and tab 2 (now current) shows two panes in the grid.
    await waitForCondition(
      ctx.page,
      async () => {
        const out = String(await ctx.session.query("list-panes -a -F '#{pane_id}\t#{window_id}'"));
        return out.split('\n').some((l) => l === `${movedPaneId}\t${secondWindowId}`);
      },
      10000,
      'tmux to report the pane in the other window',
    );
    await waitForPaneCount(ctx.page, 2);
    // The count can reach two before the moved pane is laid out at its size.
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate((id) => {
          const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 50 && r.height > 20;
        }, movedPaneId),
      10000,
      'the moved pane to be laid out in the other tab',
    );

    // Step 2: drag tab 2's row above tab 1's. Mid-drag the row rides with the
    // pointer and tab 1 carries the drop bar; the drop reorders.
    const rowsBefore = await tabRows(ctx.page);
    expect(rowsBefore.map((r) => r.id)).toEqual([firstWindowId, secondWindowId]);
    const [rowOne, rowTwo] = rowsBefore;
    await ctx.page.mouse.move(rowTwo.x + rowTwo.w / 2, rowTwo.y + rowTwo.h / 2);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(rowOne.x + rowOne.w / 2, rowOne.y + 2, { steps: 8 });
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          ([one, two]) =>
            document
              .querySelector(`[data-testid="tree-tab-${two}"]`)
              ?.classList.contains('is-dragging') &&
            document
              .querySelector(`[data-testid="tree-tab-${one}"]`)
              ?.classList.contains('is-drop-before'),
          [firstWindowId, secondWindowId],
        ),
      3000,
      'the lifted tab row and the drop bar',
    );
    const lifted = (await tabRows(ctx.page)).find((r) => r.id === secondWindowId);
    expect(lifted.y).toBeLessThan(rowTwo.y - 10);
    await ctx.page.mouse.up();

    await waitForCondition(
      ctx.page,
      async () => (await tabRows(ctx.page))[0]?.id === secondWindowId,
      8000,
      'the dragged tab row to become the first',
    );
    const tmuxOrder = String(await ctx.session.query("list-windows -F '#{window_id}'"))
      .split('\n')
      .filter((id) => [firstWindowId, secondWindowId].includes(id));
    expect(tmuxOrder).toEqual([secondWindowId, firstWindowId]);
    // The strip agrees with the tree.
    expect(
      await ctx.page.evaluate(() =>
        [...document.querySelectorAll('.tab-list .tab-name[data-window-id]')].map(
          (el) => el.dataset.windowId,
        ),
      ),
    ).toEqual([secondWindowId, firstWindowId]);
    expect(
      await ctx.page.evaluate(() =>
        document.querySelector('.sidebar-tree .is-dragging, .sidebar-tree .is-drop-before'),
      ),
    ).toBeNull();
  }, 120000);
});
