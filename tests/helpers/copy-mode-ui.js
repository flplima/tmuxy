/**
 * Copy Mode UI Operations
 *
 * Enter/exit copy mode and paste operations via keyboard.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');
const { sendPrefixCommand } = require('./keyboard');

/**
 * Enter copy mode via keyboard (Ctrl+A [)
 */
async function enterCopyModeKeyboard(page) {
  await sendPrefixCommand(page, '[');
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
  pasteText,
};
