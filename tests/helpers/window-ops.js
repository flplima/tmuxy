const { tmuxExec } = require('./tmux-socket');
/**
 * Window Operations
 *
 * Create, navigate, rename, and kill tmux windows via keyboard/commands.
 */

const { delay, waitForCondition } = require('./browser');
const { DELAYS } = require('./config');
const {
  sendPrefixCommand,
  tmuxCommandKeyboard,
  focusTerminal,
  waitForKeybindings,
} = require('./keyboard');

/**
 * Press a window-switching binding until the active window actually changes.
 *
 * Headless Playwright Chromium occasionally drops the keydown between
 * `keyboard.up(modifier)` and the following `keyboard.press(key)`: prefix mode
 * is entered and the binding exists, but the key never fires in the page. So
 * the press needs retrying.
 *
 * The retry must re-check the window index FIRST. next/prev toggle, so with
 * exactly two windows a press that landed just after its wait expired would be
 * undone by the retry — the condition reads false again and the attempts can be
 * spent oscillating between the two windows, reporting "did not change" when
 * the binding worked every time.
 *
 * @param {Object} ctx - Test context (needs .page and .session)
 * @param {Function} press - Sends the binding, e.g. nextWindowKeyboard
 * @param {string} label - Name used in the failure message
 */
async function pressUntilWindowChanged(ctx, press, label, attempts = 3) {
  const startIndex = await ctx.session.getCurrentWindowIndex();
  const changed = async () => (await ctx.session.getCurrentWindowIndex()) !== startIndex;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && (await changed())) return;
    await press(ctx.page);
    try {
      await waitForCondition(ctx.page, changed, 3000, `${label} to change active window`);
      return;
    } catch {
      // Key was dropped before reaching the page — press again.
    }
  }
  // One last look: the final press may have landed as the wait expired.
  if (await changed()) return;
  throw new Error(`${label} did not change active window after ${attempts} attempts`);
}

/**
 * Create a new window the way a user does: `prefix c`. It goes through the
 * keyboard actor and the adapter's serial command queue, so it lands after any
 * key the test pressed before it. A side-channel POST to /commands used to
 * stand in for it and could overtake a tab switch still in flight: tmux then
 * made the new window and the late `select-window` took it away again.
 */
async function createWindowKeyboard(page) {
  const before = await windowCount(page);
  const known = await page.evaluate(
    () => window.app?.getSnapshot()?.context?.windows?.map((w) => w.id) ?? [],
  );
  await sendPrefixCommand(page, 'c');
  // A new tab is created selected, so "done" is tmux's new window existing
  // AND being the active one: the count rises a beat before the active window
  // follows, and a caller reading activeWindowId at that beat got the old tab.
  await waitForCondition(
    page,
    async () =>
      page.evaluate(
        ({ before, known }) => {
          const c = window.app?.getSnapshot()?.context;
          // `@N`, not the optimistic placeholder the client shows until
          // tmux confirms the window: a caller keys later steps on this id.
          return (
            (c?.windows?.length ?? 0) > before &&
            /^@\d+$/.test(c?.activeWindowId ?? '') &&
            !known.includes(c.activeWindowId)
          );
        },
        { before, known },
      ),
    8000,
    async () =>
      `the new window to exist and be active (had ${before})\nclient: ${await page.evaluate(() => {
        const c = window.app?.getSnapshot()?.context;
        return JSON.stringify({
          active: c?.activeWindowId,
          activePane: c?.activePaneId,
          windows: c?.windows?.map((w) => [w.id, w.active, w.windowType ?? null]),
          panes: c?.panes?.map((p) => [p.tmuxId, p.windowId]),
        });
      })}\ntmux: ${tmuxExec("list-windows -a -F '#{session_name}:#{window_id}#{?window_active,*,}#{?window_last_flag,-,}'").replace(/\n/g, ' ')}`,
  );
}

/** How many windows the app currently knows about. */
async function windowCount(page) {
  return page.evaluate(() => window.app?.getSnapshot()?.context?.windows?.length ?? 0);
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
  // Root bindings are matched against the same keybinding table as prefix ones,
  // so it must be loaded before the chord is delivered. waitForKeybindings
  // already resolves on that, so no beat is needed after it.
  await waitForKeybindings(page);
  const before = await activeWindowId(page);
  await page.keyboard.press('Control+Shift+Tab');
  // `pressUntilWindowChanged` retries this helper when the chord is dropped,
  // so a press that does not land must fail here rather than resolve blindly.
  await waitForCondition(
    page,
    async () => (await activeWindowId(page)) !== before,
    3000,
    'C-S-Tab to change the active window',
  );
}

/** The app's current active window id. */
async function activeWindowId(page) {
  return page.evaluate(() => window.app?.getSnapshot()?.context?.activeWindowId ?? null);
}

/**
 * Switch to window by number via tmux command.
 * The .tmuxy.conf binds Alt+number as root bindings (no prefix needed)
 * for window selection, but the keyboard actor may not route Alt reliably.
 * Using the command prompt is more reliable.
 */
async function selectWindowKeyboard(page, number) {
  await tmuxCommandKeyboard(page, `select-window -t :${number}`);
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
  createWindowKeyboard,
  pressUntilWindowChanged,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
};
