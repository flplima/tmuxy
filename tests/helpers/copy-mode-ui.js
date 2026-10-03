/**
 * Copy Mode UI Operations
 *
 * Enter/exit copy mode and paste operations via keyboard.
 */

const { delay, waitForCondition } = require('./browser');
const { DELAYS } = require('./config');
const { sendPrefixCommand } = require('./keyboard');

/**
 * Enter copy mode via keyboard (Ctrl+A [)
 */
async function enterCopyModeKeyboard(page) {
  await sendPrefixCommand(page, '[');
}

/**
 * Exit copy mode via keyboard (q in vi mode)
 */
async function exitCopyModeKeyboard(page) {
  // Which panes are in copy mode BEFORE the key: `q` exits one of them, and
  // waiting for *every* pane to be out would hang a test that deliberately
  // left a second pane in copy mode.
  const panesInCopyMode = () =>
    page.evaluate(() =>
      Object.entries(window.app?.getSnapshot()?.context?.copyModeStates ?? {})
        .filter(([, state]) => Boolean(state?.mode))
        .map(([paneId]) => paneId),
    );
  const before = (await panesInCopyMode()).length;

  await page.keyboard.press('q');

  // The client-side engine dropping the pane's mode is the end of the gesture
  // (docs/COPY-MODE.md), and it is readable from the app — unlike the 500ms
  // this replaced, which was the same number whether the exit took 20ms or
  // never happened at all.
  if (before > 0) {
    await waitForCondition(
      page,
      async () => (await panesInCopyMode()).length < before,
      5000,
      'copy mode to exit',
    );
  }
}

/**
 * Paste from tmux buffer via keyboard (prefix+])
 */
async function pasteBufferKeyboard(page) {
  await sendPrefixCommand(page, ']');
  await delay(DELAYS.LONG);
}

/**
 * Paste text into the terminal via a synthetic ClipboardEvent
 */
async function pasteText(page, text) {
  await page.evaluate((t) => {
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    event.clipboardData.setData('text/plain', t);
    window.dispatchEvent(event);
  }, text);
  await delay(DELAYS.LONG);
}

module.exports = {
  enterCopyModeKeyboard,
  exitCopyModeKeyboard,
  pasteBufferKeyboard,
  pasteText,
};
