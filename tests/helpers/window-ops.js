const { tmuxExec } = require('./tmux-socket');
/**
 * Window Operations
 *
 * Create, navigate, rename, and kill tmux windows via keyboard/commands.
 */

const { waitForCondition } = require('./browser');
const {
  sendPrefixCommand,
  tmuxCommandKeyboard,
  focusTerminal,
  getPrefixKey,
} = require('./keyboard');

/**
 * Press a window-switching binding once and wait for the tab the app shows to
 * change. A key the page drops fails here: retrying it would hide the very
 * bug a keyboard test is for.
 */
async function pressChangingWindow(ctx, press, label) {
  const startIndex = await ctx.session.getCurrentWindowIndex();
  await press(ctx.page);
  await waitForCondition(
    ctx.page,
    async () => (await ctx.session.getCurrentWindowIndex()) !== startIndex,
    10000,
    `${label} to change the active window`,
  );
}

/**
 * Create a new window the way a user does: `prefix c`. It goes through the
 * keyboard actor and the adapter's serial command queue, so it lands after any
 * key the test pressed before it; a side channel could overtake a tab switch
 * still in flight, whose late `select-window` takes the new window away.
 */
async function createWindowKeyboard(page) {
  const before = await windowCount(page);
  const known = await page.evaluate(() => window.app?.view().windows.map((w) => w.id) ?? []);
  await sendPrefixCommand(page, 'c');
  // A new tab is created selected, so "done" is a new window existing AND
  // being the active one: the count rises a beat before the active tab follows.
  await waitForCondition(
    page,
    async () =>
      page.evaluate(
        ({ before, known }) => {
          const v = window.app?.view();
          // `@N`, not the optimistic placeholder the client shows until
          // tmux confirms the window: a caller keys later steps on this id.
          return (
            (v?.windows.length ?? 0) > before &&
            /^@\d+$/.test(v?.activeTabId ?? '') &&
            !known.includes(v.activeTabId)
          );
        },
        { before, known },
      ),
    8000,
    async () =>
      `the new window to exist and be active (had ${before})\nclient: ${await page.evaluate(() => {
        const v = window.app?.view();
        return JSON.stringify({
          active: v?.activeTabId,
          activePane: v?.activePaneId,
          windows: v?.windows.map((w) => [w.id, w.kind]),
          visiblePanes: v?.visiblePaneIds,
        });
      })}\ntmux: ${tmuxExec("list-windows -a -F '#{session_name}:#{window_id}#{?window_active,*,}#{?window_last_flag,-,}'").replace(/\n/g, ' ')}`,
  );
}

/** How many windows the app currently knows about. */
async function windowCount(page) {
  return page.evaluate(() => window.app?.view().windows.length ?? 0);
}

/**
 * Switch to next window via keyboard
 */
async function nextWindowKeyboard(page) {
  await sendPrefixCommand(page, 'n');
}

/**
 * Switch to previous window via keyboard.
 *
 * NOT `prefix p`: tmuxy rebinds `p` to enter its PANE key table, so tmux's
 * default previous-window binding is gone. `prefix M-p` is `previous-window -a`,
 * which only steps between windows carrying an alert. The real binding is the
 * root chord C-S-Tab / C-BTab, which needs no prefix.
 */
async function prevWindowKeyboard(page) {
  await focusTerminal(page);
  // Root bindings arrive with the prefix ones, so the chord waits for them.
  await getPrefixKey(page);
  const before = await activeWindowId(page);
  await page.keyboard.press('Control+Shift+Tab');
  await waitForCondition(
    page,
    async () => (await activeWindowId(page)) !== before,
    3000,
    'C-S-Tab to change the active window',
  );
}

/** The app's current active window id. */
async function activeWindowId(page) {
  return page.evaluate(() => window.app?.view().activeTabId ?? null);
}

/**
 * Switch to window by number via tmux command.
 * The .tmuxy.conf binds Alt+number as root bindings (no prefix needed)
 * for window selection, but the keyboard actor may not route Alt reliably.
 * Using the command prompt is more reliable.
 */
async function selectWindowKeyboard(page, number) {
  await tmuxCommandKeyboard(page, `select-window -t :${number}`);
  // A keyboard command right after this is pinned to the window the app holds,
  // so the app — not just tmux — has to be on the new window first.
  await waitForCondition(
    page,
    async () => {
      const tab = await page.evaluate(() => window.app?.view().activeTabId ?? '');
      return (
        /^@\d+$/.test(tab) &&
        tmuxExec(`display-message -p -t ${tab} '#{window_index}'`) === String(number)
      );
    },
    8000,
    `the app to make window ${number} active`,
  );
}

/**
 * Switch to the last visited window.
 *
 * tmuxy binds no last-window key at all — `prefix l` is `select-pane -R`, which
 * moves between panes and never changes the window. Drive it through the tmux
 * command prompt instead, the same real user path selectWindowKeyboard and
 * renameWindowKeyboard use.
 */
async function lastWindowKeyboard(page) {
  await tmuxCommandKeyboard(page, 'last-window');
}

/**
 * Rename current window via tmux command prompt.
 * Note: prefix+, opens a rename prompt in the tmux status line. The keyboard
 * actor routes keystrokes via send-keys to the pane, not to the rename prompt.
 * So we use the command prompt instead.
 */
async function renameWindowKeyboard(page, name) {
  await tmuxCommandKeyboard(page, `rename-window "${name}"`);
}

/**
 * Kill current window via tmux command prompt.
 * Note: prefix+& uses confirm-before which shows a prompt in the tmux status
 * line. The keyboard actor routes 'y' via send-keys to the pane, not to the
 * confirm prompt. So we use the command prompt instead.
 */
async function killWindowKeyboard(page) {
  const before = await windowCount(page);
  await tmuxCommandKeyboard(page, 'kill-window');
  await waitForCondition(
    page,
    async () => (await windowCount(page)) < before,
    8000,
    `window count to fall below ${before}`,
  );
}

module.exports = {
  activeWindowId,
  windowCount,
  createWindowKeyboard,
  pressChangingWindow,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
};
