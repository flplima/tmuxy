/**
 * Xvfb: the X11 display WebKitGTK needs to run the Tauri app headlessly.
 *
 * A display already answering on :99 is used as it is: CI starts one for the
 * smoke test before this suite runs (.github/actions/start-xvfb). Killing it
 * to start another raced its exit: the new server found the old one's lock
 * and socket still there, refused to start, and nothing served :99.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DISPLAY = ':99';
const RESOLUTION = '1280x720x24';
const LOCK = '/tmp/.X99-lock';
const SOCKET = '/tmp/.X11-unix/X99';
const LOG = path.join(os.tmpdir(), 'tmuxy-tauri-xvfb.log');

// Only a server this suite started is stopped by it.
let xvfbProcess = null;

function answers() {
  try {
    execSync(`xdpyinfo -display ${DISPLAY}`, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` is a running process: an exited one may linger as a zombie. */
function running(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** Wait for `holds()`, giving up at `limitMs` with `what` in the error. */
function waitFor(what, holds, limitMs) {
  const start = Date.now();
  while (!holds()) {
    if (Date.now() - start > limitMs) throw new Error(`${what} (${limitMs / 1000} s)`);
    execSync('sleep 0.1');
  }
}

/** A lock whose server no longer answers: end that server, then clear what it left. */
function clearStaleDisplay() {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(LOCK, 'utf8').trim()) || null;
  } catch {
    // No lock.
  }
  if (pid && running(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already.
    }
    waitFor(`the stale Xvfb ${pid} on ${DISPLAY} did not exit`, () => !running(pid), 10000);
  }
  for (const file of [LOCK, SOCKET]) fs.rmSync(file, { force: true });
}

function startXvfb() {
  process.env.DISPLAY = DISPLAY;
  if (xvfbProcess || answers()) return;

  clearStaleDisplay();

  const log = fs.openSync(LOG, 'w');
  xvfbProcess = spawn('Xvfb', [DISPLAY, '-screen', '0', RESOLUTION, '-ac', '-nolisten', 'tcp'], {
    stdio: ['ignore', log, log],
    detached: true,
  });
  xvfbProcess.unref();
  fs.closeSync(log);

  const pid = xvfbProcess.pid;
  // Keep waiting while the server is alive (a cold runner is slow to bring it
  // up); a server that exited will never answer, so say why at once.
  waitFor(
    `Xvfb did not come up on ${DISPLAY}`,
    () => {
      if (answers()) return true;
      if (!running(pid)) {
        const said = fs.readFileSync(LOG, 'utf8').trim();
        throw new Error(`Xvfb exited before ${DISPLAY} came up:\n${said || '(no output)'}`);
      }
      return false;
    },
    60000,
  );
}

function stopXvfb() {
  if (!xvfbProcess) return;
  const pid = xvfbProcess.pid;
  xvfbProcess = null;
  try {
    process.kill(-pid, 'SIGTERM');
    waitFor(`Xvfb ${pid} did not exit`, () => !running(pid), 10000);
  } catch {
    // Already gone, or slow to go: the next start clears what it left.
  }
  for (const file of [LOCK, SOCKET]) fs.rmSync(file, { force: true });
}

module.exports = { startXvfb, stopXvfb };
