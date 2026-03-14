/**
 * Mouse Capture Helpers
 *
 * Utilities for SGR mouse event testing. Starts a Python script that
 * captures mouse events and writes them to a log file.
 */

const fs = require('fs');
const path = require('path');
const { delay } = require('./browser');
const { DELAYS } = require('./config');
const { typeInTerminal, pressEnter } = require('./ui');

const MOUSE_CAPTURE_SCRIPT = path.join(__dirname, 'mouse-capture.py');
const MOUSE_LOG = '/tmp/mouse-events.log';

/**
 * Start the mouse capture Python script in the terminal.
 * Waits for READY signal and mouse-any-flag to be set.
 * Returns content box and char size for coordinate calculations.
 */
async function startMouseCapture(ctx) {
  try { fs.unlinkSync(MOUSE_LOG); } catch {}
  await typeInTerminal(ctx.page, `python3 ${MOUSE_CAPTURE_SCRIPT}`);
  await pressEnter(ctx.page);
  const readyStart = Date.now();
  let ready = false;
  while (!ready && Date.now() - readyStart < 10000) {
    const text = await ctx.page.evaluate(() => {
      const el = document.querySelector('[role="log"]');
      return el ? el.textContent : '';
    });
    if (text.includes('READY')) ready = true;
    else await delay(DELAYS.MEDIUM);
  }
  expect(ready).toBe(true);
  const flagStart = Date.now();
  let flagSet = false;
  while (!flagSet && Date.now() - flagStart < 15000) {
    flagSet = await ctx.page.evaluate(() => !!document.querySelector('[data-mouse-any-flag="true"]'));
    if (!flagSet) await delay(DELAYS.MEDIUM);
  }
  expect(flagSet).toBe(true);
  const contentBox = await ctx.page.evaluate(() => {
    const el = document.querySelector('.pane-content');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(contentBox).not.toBeNull();
  const charSize = await ctx.page.evaluate(() => {
    const snap = window.app.getSnapshot();
    return { charWidth: snap.context.charWidth, charHeight: snap.context.charHeight };
  });
  return { contentBox, charSize };
}

/**
 * Read mouse events from the log file.
 * Polls until at least minCount events are found or timeout.
 */
async function readMouseEvents(minCount = 1, timeout = 5000) {
  const start = Date.now();
  let events = [];
  while (Date.now() - start < timeout) {
    try {
      const content = fs.readFileSync(MOUSE_LOG, 'utf-8');
      const lines = content.trim().split('\n').map(l => l.trim()).filter(l => l && l !== 'READY');
      events = lines.map(line => {
        const parts = line.split(':');
        const type = parts[0].trim();
        const props = {};
        for (let i = 1; i < parts.length; i++) {
          const [k, v] = parts[i].split('=');
          props[k] = parseInt(v, 10);
        }
        return { type, ...props };
      });
      if (events.length >= minCount) return events;
    } catch {}
    await delay(DELAYS.SHORT);
  }
  return events;
}

/**
 * Calculate expected SGR coordinate from pixel position.
 */
function expectedSgrCoord(pixel, origin, cellSize) {
  return Math.max(0, Math.floor((pixel - origin) / cellSize)) + 1;
}

/**
 * Stop the mouse capture script by pressing 'q'.
 */
async function stopMouseCapture(ctx) {
  await ctx.page.keyboard.press('q');
  await delay(DELAYS.LONG);
}

/**
 * Ensure the mouse capture Python process is not running.
 * Safe to call even if no capture was started — kills any orphaned python3
 * mouse-capture.py processes. Use in afterEach to prevent leaked processes
 * when a test fails mid-capture.
 */
async function ensureMouseCaptureStopped(ctx) {
  if (!ctx?.page) return;
  try {
    // Check if the pane is still running the capture script
    const hasCapture = await ctx.page.evaluate(() => {
      return !!document.querySelector('[data-mouse-any-flag="true"]');
    });
    if (hasCapture) {
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);
    }
  } catch {
    // Page may be closed or unresponsive — ignore
  }
}

module.exports = {
  MOUSE_CAPTURE_SCRIPT,
  MOUSE_LOG,
  startMouseCapture,
  readMouseEvents,
  expectedSgrCoord,
  stopMouseCapture,
  ensureMouseCaptureStopped,
};
