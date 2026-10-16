/**
 * Copy Mode UI Operations
 *
 * Enter/exit copy mode and paste operations via keyboard.
 */

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
/**
 * Paste `text` the way the browser delivers a paste: a ClipboardEvent on the
 * focused element, bubbling to the window listener. Resolves to whether the
 * app took the paste (prevented the default) — the pane does, a field
 * being edited does not.
 */
async function pasteText(page, text) {
  return page.evaluate((t) => {
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    event.clipboardData.setData('text/plain', t);
    (document.activeElement || window).dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}

module.exports = {
  enterCopyModeKeyboard,
  pasteText,
};
