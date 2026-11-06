#!/usr/bin/env node

/**
 * Post-build smoke test of the desktop app, on Linux and macOS: launch it
 * through WebDriver, type a command, see its output, then read the app's log
 * for a healthy connection.
 *
 * Linux:  tauri-driver (WebKitGTK WebDriver) + Xvfb
 * macOS:  tauri-webdriver (embeds WebDriver in app via tauri-plugin-webdriver)
 *
 * Usage: node smoke-test.js <binary-path>
 *
 * Prerequisites (managed by the CI workflow, not this script):
 *   - Linux: tauri-driver running on port 4444, DISPLAY set (Xvfb)
 *   - macOS: tauri-webdriver running on port 4444, tmux installed
 *   - tmux installed and in PATH
 *
 * The app is launched by that driver, outside this process, so it attaches to
 * the socket its own default names — `tmuxy` — unless the workflow set
 * TMUX_SOCKET for both. This process resolves the same one, so the session it
 * clears before and after is the one the app will use.
 */

process.env.TMUX_SOCKET = process.env.TMUX_SOCKET || 'tmuxy';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  launchApp,
  killTmuxSession,
  waitForAppReady,
  typeKeys,
  pressKey,
  waitForTerminalText,
} = require('../tauri/helpers/wdio-client');

const BINARY = process.argv[2];
if (!BINARY) {
  console.error('Usage: node smoke-test.js <binary-path>');
  process.exit(1);
}

const BINARY_PATH = path.resolve(BINARY);
const SESSION_NAME = 'tmuxy'; // the app's default session
const APP_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 30000;
// The app's log file lives in its state dir (`tmuxy-core/src/paths.rs`):
// `~/Library/Application Support/tmuxy` on macOS, `$XDG_STATE_HOME` (else
// `~/.local/state`) `/tmuxy` elsewhere; `TMUXY_STATE_DIR` moves it.
function stateDir() {
  if (process.env.TMUXY_STATE_DIR) return process.env.TMUXY_STATE_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'tmuxy');
  }
  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'tmuxy',
  );
}
const DEBUG_LOG = path.join(stateDir(), 'tmuxy.log');

function truncateDebugLog() {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.writeFileSync(DEBUG_LOG, '');
  } catch {
    // Log may not exist yet; the app creates it on first write.
  }
}

/**
 * The app's log shows one healthy connection: the typed marker can come back
 * while the app reconnected silently behind it (tmux crashed and was
 * reattached). No `FATAL:` (the bounded retry gave up; tauri `monitor.rs`
 * writes it) and at most two `control mode connected successfully` lines
 * (`tmuxy-core` `connection/spawn.rs`): more is a reconnect loop, the pattern
 * a macOS Finder launch once produced.
 */
function assertHealthyDebugLog() {
  let contents;
  try {
    contents = fs.readFileSync(DEBUG_LOG, 'utf8');
  } catch (err) {
    throw new Error(`Could not read debug log at ${DEBUG_LOG}: ${err.message}`);
  }

  if (/FATAL:/.test(contents)) {
    throw new Error(
      `Debug log contains FATAL — bounded retry gave up.\n` + `Tail:\n${contents.slice(-2000)}`,
    );
  }

  const connectMarker = 'control mode connected successfully';
  const connectCount = (contents.match(new RegExp(connectMarker, 'g')) || []).length;
  if (connectCount > 2) {
    throw new Error(
      `Debug log shows ${connectCount} reconnects (expected ≤ 2). ` +
        `Connection is unstable. Tail:\n${contents.slice(-2000)}`,
    );
  }

  console.warn(`Debug log healthy: ${connectCount} connect event(s), no FATAL`);
}

async function smokeTest() {
  let driver;
  const launchedAt = Date.now();
  try {
    driver = await launchApp(BINARY_PATH);
    console.warn(`WebDriver session created — app launched (${Date.now() - launchedAt}ms)`);

    await waitForAppReady(driver, APP_READY_TIMEOUT);
    console.warn('Shell prompt detected');

    const marker = `SMOKE_${Date.now()}`;
    const command = `echo '${marker}'`;
    await typeKeys(driver, command);
    await pressKey(driver, 'Enter');
    console.warn(`Typed: ${command}`);

    // Twice: once as typed, once as the echo's output.
    await waitForTerminalText(driver, marker, COMMAND_TIMEOUT, 2);
    console.warn('Command output verified in terminal UI');
    console.warn('Smoke test passed');
  } finally {
    if (driver) {
      try {
        await driver.deleteSession();
      } catch {
        // Already gone.
      }
    }
  }
}

async function main() {
  console.warn(`Binary: ${BINARY_PATH}`);
  console.warn(`Platform: ${process.platform}`);

  // The log assertions read this run's output only.
  killTmuxSession(SESSION_NAME);
  truncateDebugLog();

  try {
    await smokeTest();
    assertHealthyDebugLog();
  } finally {
    killTmuxSession(SESSION_NAME);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Smoke test FAILED:', err.message);
    process.exit(1);
  });
