/**
 * Xvfb: the X11 display WebKitGTK needs to run the Tauri app headlessly.
 */

const { spawn, execSync } = require('child_process');

const DISPLAY = ':99';
const RESOLUTION = '1280x720x24';

let xvfbProcess = null;

function startXvfb() {
  if (xvfbProcess) return;

  // A display left over from an earlier run holds the lock.
  try {
    execSync(`kill $(cat /tmp/.X99-lock 2>/dev/null) 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // None running.
  }

  xvfbProcess = spawn('Xvfb', [DISPLAY, '-screen', '0', RESOLUTION, '-ac', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });

  xvfbProcess.unref();

  process.env.DISPLAY = DISPLAY;

  // A cold CI runner can take seconds, xdpyinfo itself ~1s to spawn on the
  // first call; 5s was missed intermittently.
  const timeoutMs = 30000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(`xdpyinfo -display ${DISPLAY}`, { stdio: 'ignore', timeout: 1000 });
      return;
    } catch {}
    execSync('sleep 0.1');
  }

  throw new Error(`Xvfb did not start within ${timeoutMs / 1000} seconds`);
}

function stopXvfb() {
  if (xvfbProcess) {
    try {
      process.kill(-xvfbProcess.pid, 'SIGTERM');
    } catch {
      // Already dead
    }
    xvfbProcess = null;
  }

  try {
    execSync('rm -f /tmp/.X99-lock', { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

module.exports = { startXvfb, stopXvfb };
