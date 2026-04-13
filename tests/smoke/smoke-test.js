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
 */

const { remote } = require('webdriverio');
const { execSync } = require('child_process');
const path = require('path');

const BINARY = process.argv[2];
if (!BINARY) {
  console.error('Usage: node smoke-test.js <binary-path>');
  process.exit(1);
}

const BINARY_PATH = path.resolve(BINARY);
const DRIVER_PORT = 4444;
const SESSION_NAME = 'tmuxy'; // default session name
const APP_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 30000;

// --- Helpers ---

function cleanupTmuxSession() {
  try {
    execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: 'ignore' });
  } catch {
    // Session may not exist
  }
}

// --- Full GUI smoke test (WebdriverIO — both platforms) ---

async function smokeTest() {
  let driver;
  try {
    driver = await remote({
      hostname: 'localhost',
      port: DRIVER_PORT,
      capabilities: {
        'tauri:options': {
          application: BINARY_PATH,
          env: {
            DISPLAY: process.env.DISPLAY || ':99',
          },
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
        console.warn('Smoke test passed');
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

// --- Main ---

async function main() {
  console.warn(`Binary: ${BINARY_PATH}`);
  console.warn(`Platform: ${process.platform}`);

  // Clean up any leftover session
  cleanupTmuxSession();

  try {
    await smokeTest();
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
