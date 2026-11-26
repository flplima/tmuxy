/**
 * Extended keys: a program in a pane that asks for them can tell Shift+Enter
 * and Ctrl+Enter from Enter, and one that asks nothing gets what it always got
 * (`extended-keys` in tmuxy.defaults.conf, docs/TMUX-KEYS.md).
 *
 * What arrives depends on the tmux under test, so each version's bytes are
 * written down in one table, `BYTES`, and the run logs which it checked.
 */

const path = require('path');
const {
  describeE2E,
  pressEnter,
  typeInTerminal,
  waitForShellPrompt,
  waitForTerminalText,
} = require('./helpers');
const { tmuxOlderThan } = require('./helpers/tmux-socket');

const KEY_BYTES = path.join(__dirname, 'helpers', 'key-bytes.py');

/**
 * What `key-bytes.py` prints for each key pressed, by the tmux version.
 * `null`: tmux hands the program nothing for that key.
 */
const BYTES = {
  // tmux 3.5 and later, in the CSI u form the config picks.
  'CSI u form, tmux 3.5 and later': {
    asked: {
      'Shift+Enter': 'ESC[13;2u',
      'Control+Enter': 'ESC[13;5u',
      'Control+i': 'ESC[105;5u',
      Enter: 'CR',
      Tab: 'TAB',
    },
    askedNothing: { 'Shift+Enter': 'CR', 'Control+Enter': 'CR', 'Control+i': 'TAB', Enter: 'CR' },
  },
  // Older tmux writes CSI u by itself and folds Ctrl+I into Tab even for a
  // program that asked. For one that did not, it cannot encode Shift+Enter, so
  // `send-keys` types the key's name as text, and it drops Ctrl+Enter. It
  // does both with `extended-keys off` too.
  'CSI u form, tmux older than 3.5': {
    asked: {
      'Shift+Enter': 'ESC[13;2u',
      'Control+Enter': 'ESC[13;5u',
      'Control+i': 'TAB',
      Enter: 'CR',
      Tab: 'TAB',
    },
    askedNothing: {
      'Shift+Enter': 'S-Enter',
      'Control+Enter': null,
      'Control+i': 'TAB',
      Enter: 'CR',
    },
  },
};

function expected() {
  const form = tmuxOlderThan(3, 5)
    ? 'CSI u form, tmux older than 3.5'
    : 'CSI u form, tmux 3.5 and later';
  console.warn(`extended keys checked as: ${form}`);
  return BYTES[form];
}

/**
 * Run the program in the pane, press each key of `keys` and wait to read its
 * line. A key tmux hands over nothing for takes no line, so the one after it
 * carries the next number.
 */
async function pressAndRead(ctx, mode, keys) {
  const { page } = ctx;
  await typeInTerminal(page, `clear; python3 ${KEY_BYTES} ${mode}`);
  await pressEnter(page);
  await waitForTerminalText(page, 'READY');
  let count = 0;
  for (const [key, bytes] of Object.entries(keys)) {
    await page.keyboard.press(key);
    if (bytes === null) continue;
    count += 1;
    await waitForTerminalText(page, `key${count} [${bytes}]`);
  }
  // A last key of its own: its number shows that no other key left a line.
  await page.keyboard.press('z');
  await waitForTerminalText(page, `key${count + 1} [z]`);
  await page.keyboard.press('q');
  await waitForTerminalText(page, 'DONE');
  await waitForShellPrompt(page);
}

describeE2E('Extended keys', {}, (ctx) => {
  test('a program that asks for them gets Shift+Enter, Ctrl+Enter and Ctrl+I as keys', async () => {
    await ctx.setupPage();
    await pressAndRead(ctx, 'ask', expected().asked);
  }, 90000);

  test('a program that asks for nothing gets what it always got', async () => {
    await ctx.setupPage();
    await pressAndRead(ctx, '', expected().askedNothing);
  }, 90000);
});
