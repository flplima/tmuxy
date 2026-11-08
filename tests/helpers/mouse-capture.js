/**
 * Mouse Capture Helpers
 *
 * Utilities for SGR mouse event testing. Starts a Python script that
 * captures mouse events and writes them to a log file.
 */

const fs = require('fs');
const path = require('path');
const { focusPage, waitForCondition } = require('./browser');
const { typeInTerminal, pressEnter } = require('./keyboard');
const { getTerminalText } = require('./pane-ops');
const { getCellSize } = require('./cell-grid');

const MOUSE_CAPTURE_SCRIPT = path.join(__dirname, 'mouse-capture.py');
const MOUSE_LOG = '/tmp/mouse-events.log';

/**
 * What each pane in the test session is currently running, for failure
 * messages. Read-only, so it is safe while control mode is attached.
 */
function describePaneCommands(ctx) {
  try {
    return ctx.session
      .runCommand(`list-panes -t ${ctx.session.name} -F "#{pane_id}=#{pane_current_command}"`)
      .split('\n')
      .join(' ');
  } catch (err) {
    return `<unavailable: ${err.message}>`;
  }
}

/**
 * Start the mouse capture Python script in the terminal.
 * Waits for READY signal and mouse-any-flag to be set.
 * Returns content box and char size for coordinate calculations.
 *
 * `terminal` names the terminal to start it in, as a selector. By default it
 * starts in the active tiled pane — so a capture meant for the dock ran in
 * the pane instead, and the dock's clicks reached a shell that reports
 * nothing.
 */
async function startMouseCapture(ctx, { terminal } = {}) {
  try {
    fs.unlinkSync(MOUSE_LOG);
  } catch {}
  if (!terminal) await focusPage(ctx.page);
  await typeInTerminal(ctx.page, `python3 ${MOUSE_CAPTURE_SCRIPT}`, { target: terminal });
  await pressEnter(ctx.page);
  // The log file says READY before the raw-mode screen may have drawn it.
  await waitForCondition(
    ctx.page,
    () => logLines().includes('READY'),
    15000,
    async () =>
      // The command is typed through the browser, so the question is whether
      // it reached the pane at all.
      `mouse-capture to signal READY\n  pane command: ${describePaneCommands(ctx)}\n` +
      `  terminal: ${JSON.stringify((await getTerminalText(ctx.page)).slice(-300))}`,
  );
  await waitForCondition(
    ctx.page,
    () => ctx.page.evaluate(() => !!document.querySelector('[data-mouse-any-flag="true"]')),
    15000,
    'the pane to report mouse tracking on',
  );
  const contentBox = await ctx.page.evaluate(() => {
    const el = document.querySelector('.pane-content');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(contentBox).not.toBeNull();
  const charSize = await getCellSize(ctx.page);
  return { contentBox, charSize };
}

/** The lines the capture script has written so far. */
function logLines() {
  try {
    return fs
      .readFileSync(MOUSE_LOG, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The mouse events tmux has delivered to the capture script so far. */
function mouseEvents() {
  return logLines()
    .filter((l) => l !== 'READY')
    .map((line) => {
      const [type, ...fields] = line.split(':');
      const props = {};
      for (const field of fields) {
        const [k, v] = field.split('=');
        props[k] = parseInt(v, 10);
      }
      return { type: type.trim(), ...props };
    });
}

/** Wait until at least `minCount` mouse events have been delivered, and return them all. */
async function readMouseEvents(minCount = 1, timeout = 5000) {
  return waitForCondition(
    null,
    () => {
      const events = mouseEvents();
      return events.length >= minCount ? events : null;
    },
    timeout,
    () => `${minCount} mouse events (got ${mouseEvents().length})`,
  );
}

/**
 * Stop the mouse capture script by pressing 'q'.
 */
async function stopMouseCapture(ctx) {
  await ctx.page.keyboard.press('q');
  await waitForMouseTrackingOff(ctx.page);
}

/**
 * Wait for the mouse tracking flag to clear in the UI. The python script
 * disables mouse modes on exit, and the UI learns of it from the server.
 */
async function waitForMouseTrackingOff(page) {
  await waitForCondition(
    page,
    () => page.evaluate(() => !document.querySelector('[data-mouse-any-flag="true"]')),
    5000,
    'the pane to report mouse tracking off',
  );
}

/**
 * Ensure the mouse capture Python process is not running.
 * Safe to call even if no capture was started — kills any orphaned python3
 * mouse-capture.py processes. Use in afterEach to prevent leaked processes
 * when a test fails mid-capture.
 */
async function ensureMouseCaptureStopped(ctx) {
  if (!ctx?.page || ctx.page.isClosed()) return;
  const hasCapture = await ctx.page.evaluate(
    () => !!document.querySelector('[data-mouse-any-flag="true"]'),
  );
  if (hasCapture) await stopMouseCapture(ctx);
}

module.exports = {
  startMouseCapture,
  readMouseEvents,
  stopMouseCapture,
  ensureMouseCaptureStopped,
};
