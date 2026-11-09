/**
 * A new desktop window's splash page, driven as a person drives it: Window ▸
 * New Window, then the page's own fields and buttons, found by their labels.
 */

const { invokeWindowCommand } = require('./wdio-client');

/**
 * Open a new GUI window and switch the driver to it, on its splash page.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<{ mainHandle: string, splashHandle: string }>}
 */
async function openSplashWindow(driver) {
  const mainHandle = await driver.getWindowHandle();
  await invokeWindowCommand(driver, 'new_window');
  let handles = [];
  for (let i = 0; i < 60 && handles.length < 2; i++) {
    handles = await driver.getWindowHandles();
    if (handles.length < 2) await new Promise((r) => setTimeout(r, 500));
  }
  const splashHandle = handles.find((h) => h !== mainHandle);
  if (!splashHandle) throw new Error(`no second window (handles: ${handles})`);
  await driver.switchToWindow(splashHandle);
  return { mainHandle, splashHandle };
}

/**
 * The input a label names: right after it, or in the row after it (a field
 * with a button beside it).
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} label
 */
function splashField(driver, label) {
  return driver.$(
    `//label[normalize-space()="${label}"]/following-sibling::*[1][self::input or self::div]/descendant-or-self::input[1]`,
  );
}

/** The button whose text is `text`. */
function splashButton(driver, text) {
  return driver.$(`//button[normalize-space()="${text}"]`);
}

/**
 * Close the window the driver is on and go back to `mainHandle`. The window
 * closes under the script that asked, so no answer comes back.
 */
async function closeThisWindow(driver, mainHandle) {
  await invokeWindowCommand(driver, 'close_window').catch(() => {});
  await driver.switchToWindow(mainHandle);
}

module.exports = { openSplashWindow, splashField, splashButton, closeThisWindow };
