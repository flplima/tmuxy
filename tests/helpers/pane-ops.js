/**
 * Pane Operations
 *
 * Pane information, split, navigate, swap, zoom, kill, layout, and resize.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');
const {
  sendKeyCombo,
  sendPrefixCommand,
  tmuxCommandKeyboard,
  typeInTerminal,
  pressEnter,
} = require('./keyboard');

// ==================== Pane Information ====================

/**
 * Get number of visible panes in UI
 */
async function getUIPaneCount(page) {
  return await page.evaluate(() => {
    const panes = document.querySelectorAll('[data-pane-id]');
    if (panes.length > 0) {
      const uniqueIds = new Set();
      for (const pane of panes) {
        uniqueIds.add(pane.getAttribute('data-pane-id'));
      }
      return uniqueIds.size;
    }
    return document.querySelectorAll('[role="log"]').length;
  });
}

/**
 * Get UI pane details
 */
async function getUIPaneInfo(page) {
  return await page.evaluate(() => {
    const panes = document.querySelectorAll('[data-pane-id]');
    if (panes.length === 0) {
      const logs = document.querySelectorAll('[role="log"]');
      return Array.from(logs).map((log, index) => {
        const rect = log.getBoundingClientRect();
        return {
          index,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
      });
    }

    const seenIds = new Set();
    const uniquePanes = [];

    for (const pane of panes) {
      const paneId = pane.getAttribute('data-pane-id');
      if (!seenIds.has(paneId)) {
        seenIds.add(paneId);
        const rect = pane.getBoundingClientRect();
        uniquePanes.push({
          id: paneId,
          index: uniquePanes.length,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
    }
    return uniquePanes;
  });
}

/**
 * Get terminal text content
 */
/**
 * The terminals the user can actually SEE, newest layout first.
 *
 * Not every `[role="log"]` in the DOM is on screen — a pane in a background
 * tab, a parked pane-group member and a closed sidebar all keep their content
 * mounted. Joining all of them let a test pass on text nobody could read,
 * which docs/TESTS.md forbids. Each entry carries the index of its log among
 * all logs, so a follow-up check can address that exact element.
 *
 * `scope` is a CSS selector for the pane to look in ('.pane-active', or
 * `[data-pane-id="%3"]`); omitted, it takes every visible terminal.
 */
async function visibleTerminals(page, scope) {
  return await page.evaluate((sel) => {
    const logs = [...document.querySelectorAll('[role="log"]')];
    const wanted = sel ? new Set([...document.querySelectorAll(sel + ' [role="log"]')]) : null;
    const out = [];
    logs.forEach((log, index) => {
      if (wanted && !wanted.has(log)) return;
      if (log.closest('.pane-window-hidden')) return;
      if (getComputedStyle(log).visibility === 'hidden') return;
      const box = log.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      if (box.right <= 0 || box.bottom <= 0) return;
      if (box.left >= window.innerWidth || box.top >= window.innerHeight) return;
      out.push({ index, text: log.textContent || '', box: box.toJSON() });
    });
    return out;
  }, scope ?? null);
}

/**
 * The text of every terminal on screen, or of the one `scope` names.
 */
async function getTerminalText(page, { scope } = {}) {
  const seen = await visibleTerminals(page, scope);
  return seen.map((t) => t.text).join('\n');
}

/**
 * Whether `text` is not merely present in the log at `index`, but READABLE:
 * the line carrying it has a real box, inside its pane and inside the
 * viewport. A line scrolled out of its pane is in the DOM and not on screen.
 */
async function textIsReadable(page, index, text) {
  return await page.evaluate(
    ([logIndex, searchText]) => {
      const log = document.querySelectorAll('[role="log"]')[logIndex];
      if (!log || !(log.textContent || '').includes(searchText)) return { ok: false, why: 'gone' };
      const line =
        [...log.querySelectorAll('*')]
          .reverse()
          .find((el) => (el.textContent || '').includes(searchText)) ?? log;
      const pane = log.getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return { ok: false, why: 'the line has no box' };
      if (rect.bottom <= pane.top || rect.top >= pane.bottom)
        return { ok: false, why: 'the line is clipped outside its pane' };
      if (
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= window.innerWidth ||
        rect.top >= window.innerHeight
      )
        return { ok: false, why: 'the line is outside the viewport' };
      return { ok: true };
    },
    [index, text],
  );
}

/**
 * Wait for specific text to appear in terminal.
 * Uses Node-side polling with page.evaluate for reliable cross-environment behavior.
 * (Browser-side waitForFunction can miss transient DOM states on CI.)
 */
async function waitForTerminalText(page, text, timeout = 15000, { scope } = {}) {
  const start = Date.now();
  let why = 'it never appeared';
  while (Date.now() - start < timeout) {
    for (const terminal of await visibleTerminals(page, scope)) {
      if (!terminal.text.includes(text)) continue;
      const verdict = await textIsReadable(page, terminal.index, text);
      if (verdict.ok) return await getTerminalText(page, { scope });
      why = verdict.why;
    }
    await delay(100);
  }
  const content = await getTerminalText(page, { scope });
  throw new Error(
    `Timeout waiting for "${text}" to be visible in the terminal (${timeout}ms, ${why}). Content (${content.length} chars): "${content.slice(0, 200)}"`,
  );
}

/**
 * Wait for a shell prompt to appear in the terminal.
 * Matches common prompt characters: $ # % > ❯
 */
async function waitForShellPrompt(page, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const content = await getTerminalText(page);
    const found = content.length > 5 && /[$#%>❯]/.test(content);
    if (found) return await getTerminalText(page);
    await delay(100);
  }
  const content = await getTerminalText(page);
  throw new Error(
    `Timeout waiting for shell prompt (${timeout}ms). Content (${content.length} chars): "${content.slice(0, 200)}"`,
  );
}

/**
 * Run a command in terminal and wait for expected output.
 * Types via browser keyboard and verifies output appears in the DOM.
 * No fallbacks — tests the real user path end-to-end.
 */
async function runCommand(page, command, expectedOutput, timeout = 20000, { scope } = {}) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  return await waitForTerminalText(page, expectedOutput, timeout, { scope });
}

/**
 * Run a command and return terminal text after a delay (for commands without specific output)
 */
async function runCommandWithDelay(page, command, delayMs = 1000) {
  await typeInTerminal(page, command);
  await pressEnter(page);
  await delay(delayMs);
  return await getTerminalText(page);
}

// ==================== UI Interactions ====================

// ==================== Split Operations ====================

/**
 * Split pane via keyboard
 */
async function splitPaneKeyboard(page, direction = 'horizontal') {
  // Use sendPrefixCommand for reliable timing
  // " = horizontal split (Shift+'), % = vertical split (Shift+5)
  if (direction === 'horizontal') {
    await sendPrefixCommand(page, "'", { shift: true });
  } else {
    await sendPrefixCommand(page, '5', { shift: true });
  }
  await waitForLayoutSettled(page);
}

/**
 * Resolve once the grid has stopped moving: the same panes, the same boxes and
 * the same focus seen twice in a row.
 *
 * Every helper below used to sleep a flat 500ms after a split, a swap or a
 * zoom and hope tmux had answered. This returns as soon as it has — usually
 * well inside that — and keeps waiting when a loaded CI runner takes longer,
 * which is the half the sleep could not do.
 */
async function waitForLayoutSettled(page, { timeout = 10000 } = {}) {
  const sample = () =>
    page.evaluate(() => {
      const c = window.app?.getSnapshot().context;
      if (!c) return null;
      return JSON.stringify({
        activePane: c.activePaneId,
        activeWindow: c.activeWindowId,
        panes: c.panes.map((p) => [p.tmuxId, p.windowId, p.x, p.y, p.width, p.height]),
        windows: c.windows.map((w) => [w.id, w.active, w.windowType]),
      });
    });

  const start = Date.now();
  let previous = await sample();
  // No machine on the page (a raw or not-yet-hydrated page): nothing to
  // observe, so fall back to the old fixed wait rather than returning early.
  if (previous === null) return await delay(DELAYS.LONG);
  while (Date.now() - start < timeout) {
    await delay(60);
    const current = await sample();
    if (current !== null && current === previous) return;
    previous = current;
  }
}

// ==================== Navigation Operations ====================

/**
 * Navigate to pane via keyboard using root bindings (Ctrl+arrow).
 * The .tmuxy.conf binds Ctrl+arrow keys as root bindings (no prefix needed)
 * for pane navigation: C-Up=select-pane -U, C-Down=select-pane -D, etc.
 */
async function navigatePaneKeyboard(page, direction) {
  const keyMap = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };

  const key = keyMap[direction];
  if (key) {
    // Use Ctrl+arrow root binding (no prefix needed)
    await sendKeyCombo(page, 'Control', key);
    await waitForLayoutSettled(page);
  } else if (direction === 'next') {
    await sendPrefixCommand(page, 'o');
  }
}

// ==================== Swap Operations ====================

/**
 * Swap pane via keyboard
 */
async function swapPaneKeyboard(page, direction = 'down') {
  // } = swap down (Shift+]), { = swap up (Shift+[)
  if (direction === 'down') {
    await sendPrefixCommand(page, ']', { shift: true });
  } else {
    await sendPrefixCommand(page, '[', { shift: true });
  }
  await waitForLayoutSettled(page);
}

// ==================== Zoom Operations ====================

/**
 * Toggle pane zoom via keyboard
 */
async function toggleZoomKeyboard(page) {
  await sendPrefixCommand(page, 'z');
  await waitForLayoutSettled(page);
}

// ==================== Kill Operations ====================

/**
 * Kill pane via tmux command prompt.
 * Note: prefix+x uses confirm-before which shows a prompt in the tmux status
 * line. The keyboard actor routes 'y' via send-keys to the pane, not to the
 * confirm prompt. So we use the command prompt instead.
 */
async function killPaneKeyboard(page) {
  await tmuxCommandKeyboard(page, 'kill-pane');
  await waitForLayoutSettled(page);
}

// ==================== Layout Operations ====================

/**
 * Cycle layout via keyboard
 */
async function cycleLayoutKeyboard(page) {
  await sendPrefixCommand(page, ' ');
  await waitForLayoutSettled(page);
}

/**
 * Select a specific layout by name via tmux command
 */
async function selectLayoutKeyboard(page, name) {
  await tmuxCommandKeyboard(page, `select-layout ${name}`);
}

// ==================== Resize Operations ====================

/**
 * Resize pane via tmux command
 * @param {string} direction - 'U', 'D', 'L', 'R'
 * @param {number} amount - Number of cells to resize
 */
async function resizePaneKeyboard(page, direction, amount = 5) {
  await tmuxCommandKeyboard(page, `resize-pane -${direction} ${amount}`);
}

module.exports = {
  // Pane info
  getUIPaneCount,
  getUIPaneInfo,
  visibleTerminals,
  getTerminalText,
  waitForTerminalText,
  waitForShellPrompt,
  waitForLayoutSettled,
  runCommand,
  runCommandWithDelay,
  // Split
  splitPaneKeyboard,
  // Navigate
  navigatePaneKeyboard,
  // Swap
  swapPaneKeyboard,
  // Zoom
  toggleZoomKeyboard,
  // Kill
  killPaneKeyboard,
  // Layout
  cycleLayoutKeyboard,
  selectLayoutKeyboard,
  // Resize
  resizePaneKeyboard,
};
