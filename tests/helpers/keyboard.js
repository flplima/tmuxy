/**
 * Keyboard Helpers
 *
 * Focus, key combos, tmux prefix, typing, and tmux command line.
 */

const { delay, waitForCondition, waitForKeyboardFocus, clickTerminal } = require('./browser');

// ==================== Focus Helper ====================

/**
 * Focus the terminal element, clicking the ACTIVE pane's terminal.
 * Clicking a non-active pane triggers SELECT_PANE → select-pane, which
 * races with subsequent prefix binding commands (e.g., prefix+o).
 * Falls back to any terminal, then body, if the active selector fails.
 */
async function focusTerminal(page) {
  // Prefer the active pane's terminal to avoid changing the active pane
  try {
    await clickTerminal(page.locator('.pane-active [role="log"]').first());
  } catch {
    // Active pane terminal may not exist yet; try any terminal (the click
    // waits for one to appear).
    try {
      await page.click('[role="log"]', { timeout: 2000 });
    } catch {
      await page.click('body').catch(() => {});
    }
  }
  // Ensure CDP page has input focus (headless Chrome can lose it after DOM re-renders)
  await page.bringToFront();
}

// ==================== Keyboard Input ====================

/**
 * Send a key combination (e.g., Ctrl+A)
 */
async function sendKeyCombo(page, ...keys) {
  for (const key of keys.slice(0, -1)) {
    await page.keyboard.down(key);
  }
  await page.keyboard.press(keys[keys.length - 1]);
  for (const key of keys.slice(0, -1).reverse()) {
    await page.keyboard.up(key);
  }
}

/**
 * Wait until the app has the server's key bindings, and return its prefix key
 * as Playwright presses it: `C-a` is `{ modifier: 'Control', key: 'a' }`, a
 * bare key has no modifier. Until the bindings arrive the keyboard actor finds
 * nothing for the key after the prefix and drops it (keyboardActor.ts), which
 * on a slow runner the first prefix-bound action of a test can race.
 */
async function getPrefixKey(page, timeout = 5000) {
  const prefix = await waitForCondition(
    page,
    () => page.evaluate(() => window.app?.view().prefixKey ?? null),
    timeout,
    "the server's key bindings to reach the app",
  );
  const modifiers = { C: 'Control', M: 'Alt', S: 'Shift' };
  const match = /^([CMS])-(.+)$/.exec(prefix);
  return match ? { modifier: modifiers[match[1]], key: match[2] } : { modifier: null, key: prefix };
}

/**
 * Press the prefix key and wait for the app to be in prefix mode: a key
 * pressed before then is not looked up in the prefix table but sent to the
 * pane, and the binding never fires.
 */
async function sendTmuxPrefix(page) {
  await focusTerminal(page);
  const prefix = await getPrefixKey(page);
  if (prefix.modifier) {
    await page.keyboard.down(prefix.modifier);
    await delay(50);
  }
  await page.keyboard.press(prefix.key);
  if (prefix.modifier) {
    await delay(50);
    await page.keyboard.up(prefix.modifier);
  }

  // Wait for the keyboard actor to acknowledge prefix mode rather
  // than relying on a fixed delay.
  await waitForPrefixActive(page);
}

/**
 * Block until ctx.prefixActive flips true. The keyboard actor sends
 * PREFIX_MODE_CHANGE to the app machine right after enterPrefixMode();
 * once the assign lands, we know the next keypress will be looked up
 * in prefixBindings and not silently fall through to send-keys.
 */
async function waitForPrefixActive(page, timeout = 2000) {
  await waitForCondition(
    page,
    () => page.evaluate(() => window.app?.view().prefixActive === true),
    timeout,
    'prefix mode to activate',
  );
}

/**
 * Wait until the app has left prefix mode: the key after the prefix was
 * consumed and its binding dispatched. What the binding then does is the
 * caller's to wait for (`waitForPaneCount` after a split, say).
 */
async function waitForPrefixConsumed(page, timeout = 3000) {
  await waitForCondition(
    page,
    () => page.evaluate(() => window.app?.view().prefixActive !== true),
    timeout,
    'the key after the prefix to be consumed',
  );
}

/**
 * Send a tmux prefix command (prefix key followed by another key)
 * This is the recommended way to send tmux keyboard shortcuts.
 * Handles proper timing between prefix and command key.
 *
 * @param {Page} page - Playwright page
 * @param {string} key - The key to send after prefix (e.g., '[', 'c', 'z')
 * @param {Object} options - Options for key sending
 * @param {boolean} options.shift - Whether to hold shift while pressing key
 */
async function sendPrefixCommand(page, key, options = {}) {
  const { shift = false } = options;

  // Send prefix key (includes focus, delay, and PREFIX wait)
  await sendTmuxPrefix(page);

  // Send the command key
  if (shift) {
    await page.keyboard.down('Shift');
    await delay(50);
  }
  await page.keyboard.press(key);
  if (shift) {
    await delay(50);
    await page.keyboard.up('Shift');
  }

  // The key has been delivered; wait for the actor to have consumed it rather
  // than for a fixed number of milliseconds. The binding's EFFECT is the
  // caller's to wait for — see waitForPrefixConsumed.
  await waitForPrefixConsumed(page);
}

/**
 * Open a sidebar column with its key: `prefix s` for the tree (left),
 * `prefix S` for the pinned terminal (right). It opens docked beside the grid.
 * A column already open is left as it is, since the key would close it.
 */
async function openSidebarKeyboard(page, side) {
  if (await sidebarShown(page, side)) return;
  await sendTmuxPrefix(page);
  await page.keyboard.press(side === 'left' ? 's' : 'Shift+S');
  await waitForPrefixConsumed(page);
}

/** Whether a sidebar column is drawn docked beside the grid. */
async function sidebarShown(page, side) {
  return page.evaluate((s) => {
    const column = document.querySelector(`.sidebar-column-${s}`);
    if (!column) return false;
    const r = column.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, side);
}

/**
 * Type text in terminal
 */
async function typeInTerminal(page, text, { target } = {}) {
  // Click the active pane's terminal for reliable focus, or `target` when the
  // text is meant for another terminal (the dock's). Clicking the active pane
  // there would take the keyboard away from the terminal the text is for.
  // Using the first [role="log"] would change the active pane via SELECT_PANE.
  const terminal =
    (target && (await page.$(target))) ||
    (await page.$('.pane-active [role="log"]')) ||
    (await page.$('[role="log"]'));
  if (terminal) {
    await clickTerminal(terminal);
  } else {
    await page.click('body');
  }
  // Ensure the CDP page has input focus. On headless Chrome, DOM re-renders
  // (split-pane, new-window) can cause the page to lose keyboard focus.
  // bringToFront() re-establishes it at the CDP level.
  await page.bringToFront();
  // Wait for the app to be holding the keyboard rather than sleeping and
  // hoping. The hidden input (infra/dom/mobileKeyboard.ts) owns browser focus on
  // every device, so its being the active element is the signal that a
  // keystroke will land in a pane.
  await waitForKeyboardFocus(page);
  // Per-character typing with delay — the HttpAdapter batches literal
  // characters into a single send-keys -l command and serializes HTTP
  // requests, preventing transposition.
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(30);
  }
}

/**
 * Type a character the way a LAYOUT composes it, rather than as a plain key.
 *
 * Headless Chrome always runs the US layout, so a dead key, macOS Option, or
 * AltGr cannot be produced through page.keyboard at all — the only faithful
 * reproduction is the event the browser itself fires for them:
 *   'dead'   the accent key yields `Dead`, then the FINISHED character arrives
 *            stamped keyCode 229, because the OS composed it via the IME
 *   'option' macOS Option as a compose key: the character with altKey set
 *   'altgr'  the layout's third level (`@ { } ~` on ABNT2): legacy ctrl+alt
 *            flags plus the AltGraph modifier state that identifies it
 */
async function typeComposedChar(page, char, via) {
  await page.evaluate(
    ({ char, via }) => {
      const fire = (init) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
        );
      if (via === 'dead') {
        fire({ key: 'Dead', keyCode: 229 });
        fire({ key: char, keyCode: 229 });
      } else if (via === 'option') {
        fire({ key: char, altKey: true });
      } else {
        fire({ key: char, ctrlKey: true, altKey: true, modifierAltGraph: true });
      }
    },
    { char, via },
  );
}

/**
 * Commit `text` the way an IME does — pinyin, kana, hangul, the emoji picker.
 * Composition never delivers text through keydown; the committed string arrives
 * whole on `compositionend`.
 */
async function typeComposedText(page, text) {
  await page.evaluate((text) => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
  }, text);
}

/**
 * Press Enter. Keys reach tmux in the order they are pressed (the transport
 * serialises them), so the next key needs no beat; what Enter RUNS is the
 * caller's to wait for.
 */
async function pressEnter(page) {
  await page.keyboard.press('Enter');
}

// ==================== Tmux Command Line ====================

/**
 * Run a tmux command via the tmux command prompt (prefix+: then type command + Enter)
 */
async function tmuxCommandKeyboard(page, cmd) {
  await sendPrefixCommand(page, ':');
  // The prompt's input takes focus when it mounts; keys typed before then
  // would reach the pane instead.
  await waitForCondition(
    page,
    () => page.evaluate(() => document.activeElement?.classList.contains('tmux-command-input')),
    5000,
    'the command prompt to open and take focus',
  );
  // Type command character by character — adapter batching preserves order
  for (const char of cmd) {
    await page.keyboard.type(char);
    await delay(10);
  }
  await page.keyboard.press('Enter');
  // Submitting closes the prompt; what the command does is the caller's to
  // wait for.
  await waitForCondition(
    page,
    () => page.evaluate(() => !document.querySelector('[data-testid="tmux-command-mode"]')),
    5000,
    'the command prompt to close',
  );
}

/**
 * Wait until the keyboard actor sends keys where the app's context says they
 * go now. The actor hears of a focus change by message, after the context has
 * it; the hidden input's `data-keyboard-target` (infra/dom/mobileKeyboard.ts) is
 * the actor saying it has caught up. `target` is a pane id, `left-sidebar`,
 * or `focused-float` for whatever float the context has focused.
 */
async function waitForKeyboardTarget(page, target, timeout = 10000) {
  await waitForCondition(
    page,
    () =>
      page.evaluate((want) => {
        const expected =
          want === 'focused-float'
            ? window.app?.view().keyboardTarget.kind === 'float'
              ? window.app?.view().keyboardTarget.paneId
              : null
            : want;
        const input = document.querySelector('input[data-keyboard-target]');
        return Boolean(expected) && input?.dataset.keyboardTarget === expected;
      }, target),
    timeout,
    `the keyboard to send keys to ${target}`,
  );
}

module.exports = {
  waitForKeyboardFocus,
  waitForKeyboardTarget,
  focusTerminal,
  sendKeyCombo,
  getPrefixKey,
  sidebarShown,
  waitForPrefixActive,
  waitForPrefixConsumed,
  sendPrefixCommand,
  openSidebarKeyboard,
  typeInTerminal,
  typeComposedChar,
  typeComposedText,
  pressEnter,
  tmuxCommandKeyboard,
};
