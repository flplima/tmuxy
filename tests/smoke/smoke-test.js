#!/usr/bin/env node

/**
 * Post-build smoke test for the Tauri desktop app.
 *
 * Full GUI test on both Linux and macOS: launches the app via WebdriverIO,
 * types a command in the terminal, and verifies the output appears in the UI.
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
const SESSION_NAME = 'tmuxy'; // default session name
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

// --- Helpers ---

function truncateDebugLog() {
  // Start with an empty log so post-run assertions only see this run's output.
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.writeFileSync(DEBUG_LOG, '');
  } catch {
    // Log may not exist yet; the app creates it on first write.
  }
}

/**
 * Validate the debug log shows a healthy single connection lifecycle.
 *
 * Catches subtle bugs where the smoke test's marker-typing happens to succeed
 * but the app reconnected silently in the background (e.g. tmux crashed and
 * was reattached, masking control-mode regressions). Specifically guards:
 *   - The FATAL retry-cap (proves we never gave up)
 *   - Repeated "control mode connected successfully" lines (proves we didn't
 *     reconnect-loop). One is normal; >2 means the connection died and came
 *     back, which is the exact pattern the macOS Finder-launch bug produced.
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

// --- Full GUI smoke test (WebdriverIO — both platforms) ---

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
        // Session may already be gone
      }
    }
  }
}

// --- Main ---

async function main() {
  console.warn(`Binary: ${BINARY_PATH}`);
  console.warn(`Platform: ${process.platform}`);

  // Clean up any leftover session and clear the debug log so the
  // post-run assertions only inspect this run's output.
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
