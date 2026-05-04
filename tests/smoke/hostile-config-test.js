#!/usr/bin/env node

/**
 * Hostile-config regression test.
 *
 * Reproduces (on any Linux CI runner) the failure pattern that hit Felipe's
 * macOS .app launched from Finder — tmux's child shell can't exec the
 * configured `default-command` (in his case `reattach-to-user-namespace`,
 * because launchd's PATH did not include Homebrew). Without the fixes:
 *
 *   1. Each `tmux -CC new-session` connects, sees the shell die, emits %exit
 *      ~30ms later. The PTY hits broken pipe.
 *   2. The reconnect loop's failure counter resets on every "successful" connect,
 *      so the loop runs forever. The user-facing UI never reaches a stable state
 *      and never surfaces the underlying problem.
 *
 * This test plants a `.tmux.conf` whose `default-command` is a binary that
 * does not exist anywhere on PATH, points HOME at a sandboxed dir, launches
 * the app's binary, and verifies that within HARD_TIMEOUT_MS the debug log
 * shows the FATAL line — proof the bounded-retry safety net (5 strikes ⇒
 * give up) is wired in. If the FATAL never lands, either the bound is gone
 * or the underlying detection regressed.
 *
 * What this does NOT validate: the macOS-specific PATH augmentation that
 * lets Homebrew binaries actually resolve. That's task #16's territory.
 *
 * Usage: node hostile-config-test.js <binary-path>
 *
 * Prerequisites (managed by the CI workflow, not this script):
 *   - DISPLAY set (Xvfb already running)
 *   - tmux installed
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BINARY = process.argv[2];
if (!BINARY) {
  console.error('Usage: node hostile-config-test.js <binary-path>');
  process.exit(1);
}

const BINARY_PATH = path.resolve(BINARY);

// Sandbox HOME so we don't trample the runner's own ~/.tmux.conf
// or ~/tmuxy-debug.log. Everything the test needs is inside this dir.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-hostile-'));
const TMUX_CONF = path.join(SANDBOX_HOME, '.tmux.conf');
const DEBUG_LOG = path.join(SANDBOX_HOME, 'tmuxy-debug.log');
const SESSION_NAME = `tmuxy-hostile-${Date.now()}`;

// How long we're willing to wait for FATAL to appear. The bounded-retry
// path is 5 attempts × ~150ms cycle + exponential backoff up to 10s, so
// FATAL should land well under 30s in the failure case.
const HARD_TIMEOUT_MS = 45000;

// Default-command that points to an absolute path that cannot exist.
// Using an absolute path bypasses any PATH augmentation and forces the
// shell to fail on exec, matching the macOS failure mode.
const HOSTILE_TMUX_CONF = `set -g default-command "/nonexistent/tmuxy-hostile-binary -l $SHELL"
`;

function cleanupTmuxSession(env) {
  try {
    execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: 'ignore', env });
  } catch {
    // session may not exist
  }
}

function readLog() {
  try {
    return fs.readFileSync(DEBUG_LOG, 'utf8');
  } catch {
    return '';
  }
}

async function run() {
  fs.writeFileSync(TMUX_CONF, HOSTILE_TMUX_CONF);
  console.warn(`Sandbox HOME: ${SANDBOX_HOME}`);
  console.warn(`Planted hostile tmux.conf at ${TMUX_CONF}`);

  const env = {
    ...process.env,
    HOME: SANDBOX_HOME,
    TMUXY_SESSION: SESSION_NAME,
    DISPLAY: process.env.DISPLAY || ':99',
  };

  cleanupTmuxSession(env);

  console.warn(`Launching ${BINARY_PATH} with TMUXY_SESSION=${SESSION_NAME}`);
  const child = spawn(BINARY_PATH, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let fataled = false;
  let connectCount = 0;
  const start = Date.now();

  try {
    while (Date.now() - start < HARD_TIMEOUT_MS) {
      const log = readLog();

      // Count connect events to confirm the failure is reproducing
      // (i.e. each cycle does reach handshake before dying).
      connectCount = (log.match(/control mode connected successfully/g) || []).length;

      if (/FATAL:/.test(log)) {
        fataled = true;
        const fatalLine = log
          .split('\n')
          .find((l) => l.includes('FATAL:'));
        console.warn(`FATAL emitted after ${(Date.now() - start) / 1000}s`);
        console.warn(`  ${fatalLine.trim()}`);
        console.warn(`  total connect attempts before giving up: ${connectCount}`);
        break;
      }

      // Bail fast if the child died unexpectedly without the safety
      // net firing (e.g. crash, panic).
      if (child.exitCode !== null) {
        throw new Error(
          `Binary exited (code=${child.exitCode}) without emitting FATAL.\n` +
            `Log tail:\n${log.slice(-2000)}`
        );
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (!fataled) {
      const elapsed = (Date.now() - start) / 1000;
      throw new Error(
        `Did not see FATAL within ${HARD_TIMEOUT_MS / 1000}s (saw ${connectCount} connect attempts).\n` +
          `Either the bounded retry regressed, or the hostile config did not trigger the failure mode.\n` +
          `Log tail:\n${readLog().slice(-2000)}`
      );
    }

    if (connectCount < 2) {
      throw new Error(
        `FATAL fired but only ${connectCount} connect attempts logged. ` +
          `Suspicious — expected at least 2 retries before giving up. ` +
          `Either the test isn't reproducing the failure mode, or the retry counter increments too aggressively.`
      );
    }
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    // Give the process a moment to clean up before we wipe the sandbox.
    await new Promise((r) => setTimeout(r, 500));
    cleanupTmuxSession(env);
    try {
      fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  console.warn('Hostile-config test passed');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Hostile-config test FAILED:', err.message);
    process.exit(1);
  });
