/**
 * Busy panes for `key-echo-busy`: panes beside the focused one that redraw
 * like an agent's spinner, so a keystroke's echo is measured while the
 * transport and the client carry their output too.
 *
 * Each busy pane runs `cat` and says which terminal it has; this script then
 * writes the spinner's frames into those terminals itself, at a fixed rate.
 * One writer for every pane keeps the load exactly what it says (no shell
 * loop forking a `sleep` twenty times a second per pane), and it stops the
 * moment `stop()` is called, or this process exits.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The panes that redraw, beside the focused one. */
export const BUSY_PANES = 23;

/** What each busy pane prints, per second. */
export const BUSY_BYTES_PER_SECOND = 2048;

/** A frame every this many milliseconds: a spinner's pace. */
const FRAME_MS = 50;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * One frame, as an agent at work draws it: the terminal title set to the
 * spinner's glyph (Claude Code animates its title so), then back to the
 * line's start, a coloured glyph and a status, padded to `size` bytes.
 */
function frame(n, size) {
  const glyph = SPINNER[n % SPINNER.length];
  const title = `\x1b]2;${glyph} Working\x07`;
  const head = `${title}\r\x1b[36m${glyph}\x1b[0m Thinking… ${String(n).padStart(6, '0')} `;
  const fill = Math.max(0, size - Buffer.byteLength(head));
  return head + '·'.repeat(Math.floor(fill / Buffer.byteLength('·')));
}

/** A tmux command through the client's own routing, as a binding would send it. */
const tmux = (adapter, command) =>
  adapter.evaluate((c) => window.app.send({ type: 'SEND_TMUX_COMMAND', command: c }), command);

/**
 * Split the tab `windowId` (one the run made) into its focused pane and
 * `count` busy ones, and start writing to them. The focus stays where it
 * was. Every command names that tab: nothing else is touched.
 */
export async function startBusyPanes(adapter, { windowId, count = BUSY_PANES }) {
  if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`not a window id: ${windowId}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-perf-busy-'));
  const ttys = path.join(dir, 'ttys');
  const pane = `sh -c 'tty >> ${ttys}; exec cat > /dev/null'`;
  for (let i = 0; i < count; i++) {
    await tmux(adapter, `splitw -d -t ${windowId} "${pane}"`);
    await tmux(adapter, `selectl -t ${windowId} tiled`);
    await adapter.wait(150);
  }
  // Matched, not split on lines: each pane appends its own name, and the
  // newlines between them do not always survive tmux's quoting.
  // The focused pane on top, full width, the busy ones in a row under it:
  // tiled into 24, a typed line would wrap and scroll off a pane that small.
  await tmux(adapter, `selectl -t ${windowId} main-horizontal`);
  const listed = () =>
    fs.existsSync(ttys)
      ? (fs.readFileSync(ttys, 'utf8').match(/\/dev\/(?:pts\/\d+|ttys?\w+)/g) ?? [])
      : [];
  const deadline = Date.now() + 30000;
  while (listed().length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${listed().length} of ${count} busy panes started`);
    }
    await adapter.wait(100);
  }
  const fds = listed().map((tty) => fs.openSync(tty, 'w'));
  const size = Math.round((BUSY_BYTES_PER_SECOND * FRAME_MS) / 1000);
  let n = 0;
  let written = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    n++;
    const bytes = Buffer.from(frame(n, size));
    for (const fd of fds) {
      try {
        written += fs.writeSync(fd, bytes);
      } catch {
        // A pane closed under us: the others go on.
      }
    }
  }, FRAME_MS);
  timer.unref();

  let stopped = null;
  return {
    /** Stop writing (once); what was written, per pane per second. */
    stop() {
      if (stopped) return stopped;
      clearInterval(timer);
      for (const fd of fds) fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
      const seconds = (Date.now() - started) / 1000;
      stopped = {
        panes: fds.length,
        bytesPerPanePerSecond: Math.round(written / fds.length / seconds),
      };
      return stopped;
    },
  };
}

/** The tab ids tmux gave, as the client knows them (not a predicted tab's placeholder). */
export const windowIds = async (adapter) =>
  (
    await adapter.evaluate(() => (window.app.getSnapshot().context.windows ?? []).map((w) => w.id))
  ).filter((id) => /^@\d+$/.test(id));

/**
 * Run `make` (which opens one tab), and return the id of the tab it opened:
 * the one that was not there before. Throws unless there is exactly one.
 */
export async function newWindowId(adapter, make) {
  const before = new Set(await windowIds(adapter));
  await make();
  const deadline = Date.now() + 10000;
  for (;;) {
    const added = (await windowIds(adapter)).filter((id) => !before.has(id));
    if (added.length === 1) return added[0];
    if (Date.now() > deadline) throw new Error(`expected one new tab, found ${added.length}`);
    await adapter.wait(100);
  }
}

/** Close the tab `windowId`, one the run made, by its id: whether it is gone. */
export async function closeWindow(adapter, windowId) {
  await tmux(adapter, `killw -t ${windowId}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await windowIds(adapter)).includes(windowId)) return true;
    await adapter.wait(100);
  }
  return false;
}
