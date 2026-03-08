/**
 * Window Operations
 *
 * Create, navigate, rename, and kill tmux windows via keyboard/commands.
 */

const { delay } = require('./browser');
const { DELAYS, TMUXY_URL } = require('./config');
const { sendPrefixCommand, tmuxCommandKeyboard } = require('./keyboard');

/**
 * Create new window via the server's HTTP command endpoint.
 * Routes through control mode which handles the new-window → split-window +
 * break-pane workaround (since new-window crashes tmux 3.5a control mode).
 */
async function createWindowKeyboard(page) {
  await page.evaluate(async (url) => {
    const session = window.app?.getSnapshot()?.context?.sessionName || '';
    await fetch(`${url}/commands?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': '1' },
      body: JSON.stringify({ cmd: 'run_tmux_command', args: { command: 'new-window' } }),
    });
  }, TMUXY_URL);
  await delay(DELAYS.SYNC);
}

/**
 * Switch to next window via keyboard
 */
async function nextWindowKeyboard(page) {
  await sendPrefixCommand(page, 'n');
}

/**
 * Switch to previous window via keyboard
 */
async function prevWindowKeyboard(page) {
  await sendPrefixCommand(page, 'p');
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
 * Switch to last visited window via keyboard (prefix+l)
 */
async function lastWindowKeyboard(page) {
  await sendPrefixCommand(page, 'l');
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
  await tmuxCommandKeyboard(page, 'kill-window');
  await delay(DELAYS.SYNC);
}

module.exports = {
  createWindowKeyboard,
  nextWindowKeyboard,
  prevWindowKeyboard,
  selectWindowKeyboard,
  lastWindowKeyboard,
  renameWindowKeyboard,
  killWindowKeyboard,
};
