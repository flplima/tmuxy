/**
 * Pane Operations
 *
 * Pane information, split, navigate, swap, zoom, kill, layout, and resize.
 */

const { delay } = require('./browser');
const { tmuxExec } = require('./tmux-socket');
const { DELAYS, waitBudget } = require('./config');
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
 * the line carrying it has a real box and that box is inside its pane. A line
 * scrolled out of its pane is in the DOM and not on screen.
 *
 * The pane's own visibility is already established by `visibleTerminals`, so
 * the line is not re-tested against the viewport: terminal content lives in a
 * container taller than the window, and a line can sit outside the viewport's
 * box while being exactly what the user is reading.
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
  const budget = waitBudget(timeout);
  const start = Date.now();
  let why = 'it never appeared';
  while (Date.now() - start < budget) {
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
    `Timeout waiting for "${text}" to be visible in the terminal (${budget}ms, ${why}). Content (${content.length} chars): "${content.slice(0, 200)}"`,
  );
}

/**
 * Whether one terminal's text shows a shell sitting at a prompt, waiting.
 *
 * The prompt character has to be at the END of the text, not merely somewhere
 * in it. A `>` or `$` in the output of a previous command satisfied "somewhere"
 * and made this report ready while the shell was still mid-command, which is
 * how waiting for the prompt could succeed and the NEXT step fail instead.
 *
 * The cursor lives inside `[role="log"]` and always contributes a character
 * (`Cursor.tsx`), so the raw text ends with the cursor's cell. At a prompt the
 * cursor sits one cell past it over blank space, so trimming reveals the
 * prompt; mid-command it sits over the glyph it is covering, which is exactly
 * the state this must reject.
 */
function showsShellPrompt(text) {
  return /[$#%>❯]$/.test((text || '').trimEnd());
}

/**
 * The hard stop for a pane that never produces a prompt.
 *
 * Deliberately WELL under jest's own per-test budget, and that is the whole
 * point of the number. It used to be 120000 — exactly the test timeout — so
 * when a pane really did stay blank, jest's timeout fired at the same moment
 * and won: the failure read `Exceeded timeout of 120000 ms` and said nothing
 * about a shell, a prompt, or what was on screen. A diagnostic that cannot be
 * reached before the harness gives up is not a diagnostic.
 *
 * 45s is far longer than any shell takes to write its first byte, including on
 * a cold loaded runner, and leaves the rest of the budget for the test to
 * report with.
 */
const PROMPT_CEILING = 45000;

/**
 * Wait for a shell prompt to appear in a terminal on screen.
 *
 * Patience, not a stopwatch. `timeout` bounds how long the terminal may go
 * WITHOUT CHANGING, and any change resets it, so a slow runner that is still
 * drawing keeps its wait — "not ready yet" means keep waiting, never done. A
 * fixed deadline is a constant that encodes how fast the machine is: at 10s it
 * passed on a dev machine and failed on a loaded CI runner whose shell had not
 * yet written its first byte (observed content: one space).
 *
 * `ceiling` is the only bound on a pane that never stops changing, so a
 * runaway `yes` reports here rather than as an opaque jest timeout.
 */
async function waitForShellPrompt(page, timeout = 30000, { ceiling = PROMPT_CEILING } = {}) {
  return waitForPrompts(page, 'some', timeout, ceiling);
}

/**
 * What tmux itself holds for the page's session, for a failure message: each
 * pane's own screen, whether it is dead, and its process's state. A prompt on
 * tmux's screen but not in the client is a delivery fault; an empty tmux
 * screen with the shell asleep in the kernel is a shell that never started
 * talking. Never throws — it is only ever read on the way to a failure.
 */
async function tmuxSideOfSession(page) {
  try {
    const session = await page.evaluate(() => window.app?.getSnapshot()?.context?.sessionName);
    if (!session) return 'tmux: (the client names no session)';
    const panes = tmuxExec(
      `list-panes -s -t '${session}' -F '#{pane_id} pid=#{pane_pid} dead=#{pane_dead} cmd=#{pane_current_command} size=#{pane_width}x#{pane_height}'`,
    )
      .split('\n')
      .filter(Boolean);
    const lines = panes.map((row) => {
      const id = row.split(' ')[0];
      const pid = (row.match(/pid=(\d+)/) || [])[1];
      const screen = tmuxExec(`capture-pane -p -t '${id}'`).trim().slice(-160);
      let proc = '';
      try {
        proc = require('child_process')
          .execFileSync('ps', ['-o', 'pid=,stat=,wchan=,args=', '-p', pid], { encoding: 'utf8' })
          .trim();
      } catch {
        proc = '(no such process)';
      }
      return `  ${row}\n    process: ${proc}\n    tmux screen: ${JSON.stringify(screen)}`;
    });
    return `tmux side of ${session}:\n${lines.join('\n')}`;
  } catch (error) {
    return `tmux side: unreadable (${error.message.split('\n')[0]})`;
  }
}

/**
 * The shared loop behind both prompt waiters: `some` for "a shell is up
 * somewhere", `every` for "every pane on screen has one".
 *
 * One loop rather than two because the patience accounting is the subtle part
 * — a change resetting the clock, a separate ceiling for a pane that never
 * stops changing — and two copies of it drift.
 */
async function waitForPrompts(page, quantifier, timeout, ceiling) {
  const patience = waitBudget(timeout);
  const hardStop = waitBudget(ceiling);
  const started = Date.now();
  let lastText = null;
  let lastChange = Date.now();
  for (;;) {
    const terminals = await visibleTerminals(page);
    const ready =
      quantifier === 'every'
        ? terminals.length > 0 && terminals.every((t) => showsShellPrompt(t.text))
        : terminals.some((t) => showsShellPrompt(t.text));
    if (ready) return terminals.map((t) => t.text).join('\n');

    const seen = terminals.map((t) => t.text).join('\n');
    if (seen !== lastText) {
      lastText = seen;
      lastChange = Date.now();
    }
    const quietFor = Date.now() - lastChange;
    const elapsed = Date.now() - started;
    // A pane that has shown NOTHING yet is in a different state from one that
    // showed something and stopped: it has not started, so the idle budget is
    // the wrong clock for it. Judging a cold start by `patience` turns "this
    // runner is slow to fork the first shell" into a failure — the exact thing
    // a budget measured on someone's laptop cannot know. An empty pane waits
    // for the ceiling, which is the bound that exists for "this is never going
    // to happen".
    const neverStarted = (lastText ?? '').trim() === '';
    const outOfPatience = neverStarted ? elapsed >= hardStop : quietFor >= patience;
    if (outOfPatience || elapsed >= hardStop) {
      const why = neverStarted
        ? `nothing on screen after ${elapsed}ms`
        : elapsed >= hardStop
          ? `still changing after ${elapsed}ms`
          : `unchanged for ${quietFor}ms`;
      const which =
        quantifier === 'every'
          ? `${terminals.filter((t) => !showsShellPrompt(t.text)).length} of ${terminals.length} panes have no shell prompt`
          : 'no terminal shows a shell prompt';
      throw new Error(
        `Timeout waiting for a shell prompt: ${which} (${why}). ` +
          `A prompt must be the last thing in a terminal, not merely present. ` +
          `Content (${seen.length} chars): "${seen.slice(0, 200)}"\n` +
          (await tmuxSideOfSession(page)),
      );
    }
    await delay(100);
  }
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
  // " = horizontal split (Shift+'), % = vertical split (Shift+5)
  if (direction === 'horizontal') {
    await sendPrefixCommand(page, "'", { shift: true });
  } else {
    await sendPrefixCommand(page, '5', { shift: true });
  }
  await waitForLayoutSettled(page);
  // A split is not finished when the grid stops moving — it is finished when
  // the new pane has a shell that can be typed into. `waitForShellPrompt`
  // cannot answer this: it returns as soon as ANY visible terminal shows a
  // prompt, and the pane that was split already did before the key was
  // pressed. So a caller that split and then typed was racing the new shell's
  // start-up, and won only because `sendPrefixCommand` used to sleep 500ms
  // afterwards for unrelated reasons.
  await waitForEveryShellPrompt(page);
}

/**
 * Resolve once EVERY visible terminal shows a shell prompt.
 *
 * Patience, not a stopwatch, on the same terms as `waitForShellPrompt`: the
 * budget bounds how long the screen may go without changing, and any change
 * resets it, so a slow runner that is still drawing keeps its wait.
 */
async function waitForEveryShellPrompt(page, timeout = 30000, { ceiling = PROMPT_CEILING } = {}) {
  return waitForPrompts(page, 'every', timeout, ceiling);
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
 *
 * The config binds BOTH Ctrl+arrow and Ctrl+hjkl as root bindings (no prefix
 * needed) for pane navigation, through the same `tmuxy-nav-*` aliases. This
 * presses the arrow form, so a test written against it is not asserting which
 * letter key the config happens to use.
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
  waitForEveryShellPrompt,
  showsShellPrompt,
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
