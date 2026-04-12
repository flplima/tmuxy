#!/usr/bin/env node

/**
 * Post-build smoke test for the Tauri desktop app.
 *
 * On Linux: Uses WebdriverIO → tauri-driver to launch the app, type a command,
 * and verify the output appears in the terminal UI (full stack test).
 *
 * On macOS: tauri-driver doesn't support macOS (WKWebView). Falls back to
 * launching the binary directly + verifying via tmux send-keys/capture-pane
 * (verifies app→tmux connection, not UI rendering).
 *
 * Usage: node smoke-test.js <binary-path>
 *
 * Prerequisites (managed by the CI workflow, not this script):
 *   - Linux: tauri-driver running on port 4444, DISPLAY set (Xvfb)
 *   - macOS: native display available
 *   - tmux installed and in PATH
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const BINARY = process.argv[2];
if (!BINARY) {
  console.error('Usage: node smoke-test.js <binary-path>');
  process.exit(1);
}

const BINARY_PATH = path.resolve(BINARY);
const SESSION_NAME = 'tmuxy'; // default session name
const IS_MACOS = os.platform() === 'darwin';

// --- Shared helpers ---

function createTmuxSession() {
  try {
    execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: 'ignore' });
  } catch {
    // Session may not exist
  }
  execSync(`tmux new-session -d -s ${SESSION_NAME}`, { stdio: 'inherit' });
  console.warn(`tmux session "${SESSION_NAME}" created`);
}

function cleanupTmuxSession() {
  try {
    execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: 'ignore' });
  } catch {
    // Session may already be gone
  }
}

// --- Linux: Full WebdriverIO smoke test ---

async function smokeTestLinux() {
  const { remote } = require('webdriverio');

  const DRIVER_PORT = 4444;
  const APP_READY_TIMEOUT = 60000;
  const COMMAND_TIMEOUT = 30000;

  let driver;
  try {
    driver = await remote({
      hostname: 'localhost',
      port: DRIVER_PORT,
      capabilities: {
        'tauri:options': {
          application: BINARY_PATH,
          env: { DISPLAY: process.env.DISPLAY || ':99' },
        },
      },
      logLevel: 'warn',
      connectionRetryTimeout: 30000,
      connectionRetryCount: 3,
    });
    console.warn('WebDriver session created — app launched');

    // Wait for terminal UI element
    const terminal = await driver.$('[role="log"]');
    await terminal.waitForExist({ timeout: APP_READY_TIMEOUT });
    console.warn('Terminal element found');

    // Wait for shell prompt
    const promptStart = Date.now();
    while (Date.now() - promptStart < APP_READY_TIMEOUT) {
      const hasPrompt = await driver.execute(() => {
        const logs = document.querySelectorAll('[role="log"]');
        const content = Array.from(logs)
          .map((l) => l.textContent || '')
          .join('\n');
        return content.length > 5 && /[$#%>❯]/.test(content);
      });
      if (hasPrompt) break;
      await driver.pause(500);
    }
    console.warn('Shell prompt detected');

    // Focus and type
    await terminal.click();
    await driver.pause(300);

    const marker = `SMOKE_${Date.now()}`;
    const command = `echo '${marker}'`;
    for (const char of command) {
      await driver.keys(char);
      await driver.pause(30);
    }
    await driver.keys('\uE007'); // Enter
    console.warn(`Typed: ${command}`);

    // Wait for marker in terminal output (twice: command + echo output)
    const cmdStart = Date.now();
    while (Date.now() - cmdStart < COMMAND_TIMEOUT) {
      const content = await driver.execute(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return Array.from(logs)
          .map((l) => l.textContent || '')
          .join('\n');
      });
      const occurrences = content.split(marker).length - 1;
      if (occurrences >= 2) {
        console.warn('Command output verified in terminal UI');
        return;
      }
      await driver.pause(500);
    }

    const finalContent = await driver.execute(() => {
      const logs = document.querySelectorAll('[role="log"]');
      return Array.from(logs)
        .map((l) => l.textContent || '')
        .join('\n');
    });
    throw new Error(
      `Command output not visible in terminal within ${COMMAND_TIMEOUT}ms.\n` +
        `Expected marker "${marker}" to appear twice.\n` +
        `Terminal content:\n${finalContent.slice(0, 500)}`
    );
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

// --- macOS: tmux-based smoke test (tauri-driver not supported) ---

async function smokeTestMacOS() {
  const STARTUP_TIMEOUT = 30000;
  const COMMAND_TIMEOUT = 15000;

  // Launch the binary with a restricted PATH that mimics macOS GUI apps.
  // Finder/Spotlight launches get only /usr/bin:/bin:/usr/sbin:/sbin —
  // Homebrew (/opt/homebrew/bin, /usr/local/bin) is NOT included.
  // The app must find tmux on its own despite this minimal PATH.
  const guiPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  const guiEnv = { ...process.env, PATH: guiPath, TMUXY_SESSION: SESSION_NAME };
  console.warn(`Launching with restricted PATH: ${guiPath}`);

  const child = spawn(BINARY_PATH, [], {
    stdio: 'ignore',
    detached: true,
    env: guiEnv,
  });
  child.unref();
  console.warn(`App launched (pid ${child.pid})`);

  try {
    // Wait for the app to attach to the tmux session (pane count > 0 means control mode connected)
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < STARTUP_TIMEOUT) {
      try {
        const output = execSync(
          `tmux list-panes -t ${SESSION_NAME} -F '#{pane_active}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (output.length > 0) {
          ready = true;
          break;
        }
      } catch {
        // Session not ready yet
      }
      await sleep(500);
    }

    if (!ready) {
      throw new Error(`App did not connect to tmux session within ${STARTUP_TIMEOUT}ms`);
    }
    console.warn('App connected to tmux session');

    // Wait for shell prompt in the pane
    const promptStart = Date.now();
    while (Date.now() - promptStart < STARTUP_TIMEOUT) {
      try {
        const content = execSync(
          `tmux capture-pane -t ${SESSION_NAME} -p 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (content.length > 5 && /[$#%>❯]/.test(content)) {
          break;
        }
      } catch {
        // Not ready
      }
      await sleep(500);
    }
    console.warn('Shell prompt detected via tmux');

    // Send a command via tmux
    const marker = `SMOKE_${Date.now()}`;
    execSync(`tmux send-keys -t ${SESSION_NAME} "echo '${marker}'" Enter`, {
      stdio: 'ignore',
      timeout: 5000,
    });
    console.warn(`Sent: echo '${marker}'`);

    // Wait for the marker to appear in capture-pane output
    const cmdStart = Date.now();
    while (Date.now() - cmdStart < COMMAND_TIMEOUT) {
      try {
        const content = execSync(
          `tmux capture-pane -t ${SESSION_NAME} -p 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        // Marker appears twice: in the typed command and in the echo output
        const occurrences = content.split(marker).length - 1;
        if (occurrences >= 2) {
          console.warn('Command output verified via tmux capture-pane');
          return;
        }
      } catch {
        // Capture failed
      }
      await sleep(500);
    }

    const finalContent = execSync(
      `tmux capture-pane -t ${SESSION_NAME} -p 2>/dev/null || echo "(capture failed)"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    throw new Error(
      `Command output not visible within ${COMMAND_TIMEOUT}ms.\n` +
        `Expected marker "${marker}" to appear twice.\n` +
        `Pane content:\n${finalContent.slice(0, 500)}`
    );
  } finally {
    // Kill the app
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Already dead
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  console.warn(`Binary: ${BINARY_PATH}`);
  console.warn(`Platform: ${os.platform()} (${IS_MACOS ? 'macOS tmux-based' : 'Linux WebDriver'})`);

  createTmuxSession();

  try {
    if (IS_MACOS) {
      await smokeTestMacOS();
    } else {
      await smokeTestLinux();
    }
    console.warn('Smoke test passed');
  } finally {
    cleanupTmuxSession();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Smoke test FAILED:', err.message);
    process.exit(1);
  });
