/**
 * Regression Tests for Production Bugs (Part C)
 *
 * Unpinned commands landing in the visible tab, snackbar error reporting,
 * and tmux display-message notices.
 */

const {
  createTestContext,
  delay,
  waitForWindowCount,
  typeInTerminal,
  pressEnter,
  waitForCondition,
  tmuxCommandKeyboard,
  DELAYS,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');

// ==================== Scenario: commands act on the tab the user sees ====================

/**
 * Two shipped bugs shared one cause: nothing forced tmux's current window to be
 * the tab on screen, so a command that named no window ran wherever tmux
 * happened to be — usually the first tab.
 *
 * The existing coverage could not see it. Every other suite creates tabs with a
 * helper that POSTs `new-window` straight to the server, and reaches the prefix
 * through `sendPrefixCommand`, which clicks the active pane first. Both put tmux
 * back in step with the UI before the command under test ever runs. A user who
 * clicks a TAB and then presses a prefix key does neither, so this scenario
 * clicks the "+" button, clicks a tab, and drives the prefix with no pane click
 * in between.
 */
describe('Scenario: an unpinned command lands in the tab on screen', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('split and sidebar both act on the visible tab, not on tmux’s current window', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;

    // Prefix without the focus click the shared helper performs — that click
    // is what has been hiding this bug.
    const prefixNoPaneClick = async (key, shift = false) => {
      await page.keyboard.down('Control');
      await delay(60);
      await page.keyboard.press('a');
      await delay(60);
      await page.keyboard.up('Control');
      await waitForCondition(
        page,
        () => page.evaluate(() => window.app?.getSnapshot()?.context?.prefixActive === true),
        5000,
        'prefix mode',
      );
      if (shift) await page.keyboard.down('Shift');
      await page.keyboard.press(key);
      if (shift) await page.keyboard.up('Shift');
      await delay(DELAYS.LONG);
    };

    const panesByWindow = async () => {
      const raw = String(
        await ctx.session.query("list-panes -a -F '#{window_id}\t#{pane_id}'"),
      ).trim();
      const map = {};
      for (const line of raw.split('\n')) {
        const [win, pane] = line.split('\t');
        if (!win) continue;
        (map[win] = map[win] || []).push(pane);
      }
      return map;
    };
    const visibleTab = () =>
      page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId);

    // A fresh session holds one tab. Wait for the strip to draw it: setup only
    // waits for the session and a pane, and counting before the strip renders
    // read 0 on a slow runner and threw every later count off by one.
    await waitForWindowCount(page, 1);
    // Two more tabs, created the way a user does: the "+" button.
    await page.click('.tab-add');
    await waitForWindowCount(page, 2);
    await page.click('.tab-add');
    await waitForWindowCount(page, 3);

    // Land on the LAST tab by clicking it in the strip. No pane is clicked, so
    // nothing re-points tmux at this window behind the scenes.
    // A locator, not a handle: the strip re-renders as the new tab's name
    // settles, and a handle taken a moment earlier can point at a replaced node.
    await page.locator('.tab-list .tab-name').last().click();
    await delay(DELAYS.SYNC);
    const target = await visibleTab();
    expect(target).toMatch(/^@\d+$/);

    const before = await panesByWindow();
    const firstTab = await page.evaluate(
      () =>
        (window.app?.getSnapshot()?.context?.windows || [])
          .filter((w) => w.windowType === 'tab')
          .sort((a, b) => a.index - b.index)[0]?.id,
    );

    // 1. The split belongs to the tab on screen.
    await prefixNoPaneClick('5', true);
    await waitForCondition(
      page,
      async () => ((await panesByWindow())[target] || []).length === before[target].length + 1,
      8000,
      'the split to land in the visible tab',
    );
    const afterSplit = await panesByWindow();
    expect(afterSplit[firstTab].length).toBe(before[firstTab].length);

    // 2. The sidebar becomes its own window, and leaves no pane behind in any
    // tab. On the desktop transport the break-pane used to fail outright and
    // the tree stayed put as an ordinary pane.
    await prefixNoPaneClick('s');
    await waitForCondition(
      page,
      async () => {
        const names = String(await ctx.session.query("list-windows -a -F '#{window_name}'"));
        return names.includes('__sidebar-left');
      },
      15000,
      'the sidebar to become its own window',
    );
    const afterSidebar = await panesByWindow();
    expect(afterSidebar[target].length).toBe(afterSplit[target].length);
    expect(afterSidebar[firstTab].length).toBe(before[firstTab].length);
  }, 120000);
});

// ==================== Scenario: a rejected tmux command is reported ====================
//
// Every command reaches tmux over the control-mode connection and resolves
// to nothing, so tmux's `%error` is the only word the user gets when a split,
// a kill or a prompt command did nothing. The monitor attributes it to the
// command and the app shows it as a snackbar in the top-right corner — not on
// the status line, which is for status.

describe('Scenario: a rejected tmux command is reported in the snackbar', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('tmux’s message appears top-right, off the status line, and the close button dismisses it [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();
    const page = ctx.page;
    const message = "can't find window: @999";

    await tmuxCommandKeyboard(page, 'kill-window -t @999');

    const findItem = async () => {
      for (const item of await page.$$('[data-testid="snackbar-item"]')) {
        if ((await item.evaluate((el) => el.textContent)).includes(message)) return item;
      }
      return null;
    };
    await waitForCondition(page, async () => (await findItem()) !== null, 8000, 'the snackbar');
    const item = await findItem();

    // On screen, in the top-right corner of the chrome, under the tab bar.
    const box = await item.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.x).toBeGreaterThan(viewport.width / 2);
    expect(box.y).toBeLessThan(viewport.height / 4);

    // The status line stays clear of it.
    const statusText = await page.$eval('[data-testid="tmux-status-bar"]', (el) => el.textContent);
    expect(statusText).not.toContain(message);

    // The close button dismisses this entry.
    const close = await item.$('button[aria-label="Dismiss notification"]');
    await close.click();
    await waitForCondition(
      page,
      async () => (await findItem()) === null,
      5000,
      'the snackbar to close',
    );
  }, 60000);
});

// ==================== Scenario: display-message reaches the snackbar ====================
//
// tmux hands a control client its `display-message` output as a `%message`
// notification. It used to be dropped as an unknown line, so a build script's
// `tmux display-message "build done"` showed nothing, and the command prompt's
// own `display-message` was answered by the client, unexpanded.

describe('Scenario: tmux display-message shows in the snackbar as a notice', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('from a pane’s shell and from the prompt: a notice top-right, formats expanded by tmux, gone on its own', async () => {
    if (ctx.skipIfNotReady()) return;
    // `%message` exists from tmux 3.4; before it a display-message aimed at a
    // control client shows nothing (docs/STATE-MANAGEMENT.md).
    const [major, minor] = (tmuxExec('-V').match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
    if (major === 3 && minor < 4) return;
    await ctx.setupPage();
    const page = ctx.page;

    const findNotice = async (text) => {
      for (const item of await page.$$('[data-testid="snackbar-item"][role="status"]')) {
        if ((await item.evaluate((el) => el.textContent)).includes(text)) return item;
      }
      return null;
    };

    // From the pane's shell, as a build script would.
    const fromShell = `BUILD_DONE_${Date.now()}`;
    await typeInTerminal(page, `tmux display-message ${fromShell}`);
    await pressEnter(page);
    await waitForCondition(
      page,
      async () => (await findNotice(fromShell)) !== null,
      10000,
      'the shell’s message in the snackbar',
    );
    const item = await findNotice(fromShell);
    const box = await item.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeLessThan(viewport.height / 4);
    const statusText = await page.$eval('[data-testid="tmux-status-bar"]', (el) => el.textContent);
    expect(statusText).not.toContain(fromShell);

    // From the command prompt: tmux expands the format, not the client.
    const fromPrompt = `PROMPT_${Date.now()}`;
    await tmuxCommandKeyboard(page, `display-message '${fromPrompt} #{session_name}'`);
    await waitForCondition(
      page,
      async () => (await findNotice(fromPrompt)) !== null,
      10000,
      async () =>
        `the prompt’s message in the snackbar (shown: ${JSON.stringify(
          await page.$$eval('[data-testid="snackbar-item"]', (items) =>
            items.map((i) => `${i.getAttribute('role')}: ${i.textContent}`),
          ),
        )})`,
    );
    const promptNotice = await (
      await findNotice(fromPrompt)
    ).evaluate((el) => el.querySelector('.snackbar-text').textContent);
    expect(promptNotice).toBe(`${fromPrompt} ${ctx.session.name}`);

    // A notice ages out by itself.
    await waitForCondition(
      page,
      async () => (await findNotice(fromShell)) === null,
      20000,
      'the shell’s notice to clear by itself',
    );
  }, 90000);
});
