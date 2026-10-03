/**
 * Window Operations
 *
 * Create, navigate, rename, and kill tmux windows via keyboard/commands.
 */

const { delay, waitForCondition } = require('./browser');
const { DELAYS, TMUXY_URL } = require('./config');
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
 * Create new window via the server's HTTP command endpoint.
 * Routes through control mode which handles the new-window → split-window +
 * break-pane workaround (since new-window crashes tmux 3.5a control mode).
 */
async function createWindowKeyboard(page) {
  const before = await windowCount(page);
  await page.evaluate(async (url) => {
    const session = window.app?.getSnapshot()?.context?.sessionName || '';
    await fetch(`${url}/commands?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': '1' },
      body: JSON.stringify({ cmd: 'run_tmux_command', args: { command: 'new-window' } }),
    });
  }, TMUXY_URL);
  // The window arriving in the app's own state is the thing being waited for.
  // The 1.5s this replaced was long enough on the machine it was written on
  // and silently short on a loaded runner, where the next step then ran
  // against a session that still had one window.
  await waitForCondition(
    page,
    async () => (await windowCount(page)) > before,
    8000,
    `window count to rise above ${before}`,
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
