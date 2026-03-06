/**
 * Xvfb (X Virtual Framebuffer) lifecycle management
 *
 * Starts a virtual display for running GUI apps headlessly.
 * Required for Tauri/WebKitGTK which needs an X11 display.
 */

const { spawn, execSync } = require('child_process');

const DISPLAY = ':99';
const RESOLUTION = '1280x720x24';

let xvfbProcess = null;

/**
 * Start Xvfb on the configured display
 */
function startXvfb() {
  if (xvfbProcess) return;

  // Kill any existing Xvfb on this display
  try {
    execSync(`kill $(cat /tmp/.X99-lock 2>/dev/null) 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // No existing process
  }

  xvfbProcess = spawn('Xvfb', [DISPLAY, '-screen', '0', RESOLUTION, '-ac', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });

  xvfbProcess.unref();

  // Set DISPLAY for child processes
  process.env.DISPLAY = DISPLAY;

  // Wait for Xvfb to be ready
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      execSync(`xdpyinfo -display ${DISPLAY}`, { stdio: 'ignore', timeout: 1000 });
      return;
    } catch {
      // Not ready yet
    }
    execSync('sleep 0.1');
  }

  throw new Error('Xvfb did not start within 5 seconds');
}

/**
 * Stop Xvfb
 */
function stopXvfb() {
  if (xvfbProcess) {
    try {
      process.kill(-xvfbProcess.pid, 'SIGTERM');
    } catch {
      // Already dead
    }
    xvfbProcess = null;
  }

  // Clean up lock file
  try {
    execSync('rm -f /tmp/.X99-lock', { stdio: 'ignore' });
  } catch {
    // Ignore
  }
}

module.exports = { startXvfb, stopXvfb, DISPLAY };
