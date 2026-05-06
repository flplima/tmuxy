#!/usr/bin/env node

/**
 * macOS-specific sparse-PATH regression test.
 *
 * Validates the PATH-augmentation fix that lets Homebrew binaries resolve
 * when the parent process inherits launchd's sparse PATH (the failure mode
 * Felipe hit when launching tmuxy.app from Finder/Applications). The Linux
 * hostile-config test validates the *safety net* (bounded retry); this one
 * validates the *primary fix* (PATH actually getting augmented).
 *
 * Setup that the CI workflow does before invoking this test:
 *   - Install /opt/homebrew/bin/tmuxy-stay-alive (a script that just sleeps
 *     forever). This binary is *only* findable via Homebrew's bin dir; no
 *     fallback in /usr/bin.
 *   - Plant a tmux.conf at $SANDBOX_HOME/.tmux.conf with
 *       set -g default-command "tmuxy-stay-alive"
 *
 * The script then launches the binary with PATH=/usr/bin:/bin:/usr/sbin:/sbin
 * (matching launchd's sparse default), HOME pointing at the sandbox dir.
 *
 * Pass condition: after STABLE_SECONDS, the debug log shows no FATAL and at
 * most 2 "control mode connected" lines (one is normal; >2 means we're
 * reconnect-looping, which would be exactly the macOS Finder-launch bug).
 *
 * Fail condition: FATAL appears, or connect count >2, or the binary exits.
 *
 * Usage: node macos-sparse-path-test.js <binary-path>
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
  console.warn(`Skipping: this test only runs on macOS (current: ${process.platform})`);
  process.exit(0);
}

const BINARY = process.argv[2];
if (!BINARY) {
  console.error('Usage: node macos-sparse-path-test.js <binary-path>');
  process.exit(1);
}

const BINARY_PATH = path.resolve(BINARY);
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-sparse-'));
// Plant under ~/.config/tmuxy/tmuxy.conf — the desktop app passes that
// exact file to `tmux -f` and doesn't fall back to ~/.tmux.conf.
const TMUXY_CONFIG_DIR = path.join(SANDBOX_HOME, '.config', 'tmuxy');
const TMUX_CONF = path.join(TMUXY_CONFIG_DIR, 'tmuxy.conf');
const DEBUG_LOG = path.join(SANDBOX_HOME, 'tmuxy-debug.log');
const SESSION_NAME = `tmuxy-sparse-${Date.now()}`;
const HELPER_BIN = '/opt/homebrew/bin/tmuxy-stay-alive';

// How long we let the app run before asserting the connection is stable.
// Matches MIN_HEALTHY_DURATION (5s) in tauri-app/src/monitor.rs — the bound
// after which a connection counts as "long-lived" — plus headroom for any
// reconnect attempts that might still be in flight.
const STABLE_SECONDS = 12;

// Sparse PATH that mirrors what launchd hands a Finder-launched .app.
// No /opt/homebrew, no /usr/local/bin — so tmuxy-stay-alive is unreachable
// without our gui.rs PATH-augmentation fix.
const SPARSE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const HOSTILE_TMUX_CONF = `set -g default-command "tmuxy-stay-alive"
`;

function preflight() {
  if (!fs.existsSync(HELPER_BIN)) {
    throw new Error(
      `Test prerequisite missing: ${HELPER_BIN} not installed. ` +
        `The CI workflow must place a stay-alive script there before this test runs.`
    );
  }
  // Make sure the helper is genuinely Homebrew-only — fail early if some
  // identically-named binary leaked into /usr/bin and would mask the test.
  if (fs.existsSync('/usr/bin/tmuxy-stay-alive')) {
    throw new Error(
      `Test setup invalid: /usr/bin/tmuxy-stay-alive exists. ` +
        `The test relies on the helper being reachable only via Homebrew.`
    );
  }
}

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
  preflight();
  fs.mkdirSync(TMUXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TMUX_CONF, HOSTILE_TMUX_CONF);
  console.warn(`Sandbox HOME: ${SANDBOX_HOME}`);
  console.warn(`Planted tmux.conf using ${HELPER_BIN} via name (no abs path)`);
  console.warn(`Sparse PATH: ${SPARSE_PATH}`);

  const env = {
    PATH: SPARSE_PATH,
    HOME: SANDBOX_HOME,
    USER: process.env.USER || 'runner',
    TMPDIR: process.env.TMPDIR || '/tmp/',
    TMUXY_SESSION: SESSION_NAME,
    // TERM intentionally unset — matches the macOS Finder-launch env.
  };

  cleanupTmuxSession(env);

  console.warn(`Launching ${BINARY_PATH}`);
  const child = spawn(BINARY_PATH, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Forward child output for diagnosis; sometimes Tauri panics print
  // there before anything reaches the debug log.
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[child stderr] ${chunk}`);
  });

  try {
    // Let it run for STABLE_SECONDS, then inspect the log.
    for (let i = 0; i < STABLE_SECONDS; i++) {
      if (child.exitCode !== null) {
        throw new Error(
          `Binary exited (code=${child.exitCode}) before stability window elapsed.\n` +
            `Log tail:\n${readLog().slice(-2000)}`
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const log = readLog();

    if (/FATAL:/.test(log)) {
      throw new Error(
        `FATAL emitted — PATH augmentation did not resolve ${HELPER_BIN}.\n` +
          `Log tail:\n${log.slice(-2000)}`
      );
    }

    const connectCount = (log.match(/control mode connected successfully/g) || []).length;
    if (connectCount === 0) {
      throw new Error(
        `No "control mode connected" lines after ${STABLE_SECONDS}s — the app never reached handshake.\n` +
          `Log tail:\n${log.slice(-2000)}`
      );
    }
    if (connectCount > 2) {
      throw new Error(
        `Reconnect storm: ${connectCount} connect events in ${STABLE_SECONDS}s. ` +
          `Connection is unstable under sparse PATH — PATH fix likely regressed.\n` +
          `Log tail:\n${log.slice(-2000)}`
      );
    }

    console.warn(
      `Connection stable: ${connectCount} connect event(s), no FATAL, ` +
        `no reconnect storm. PATH augmentation working.`
    );
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 500));
    cleanupTmuxSession(env);
    try {
      fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  console.warn('macOS sparse-PATH test passed');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('macOS sparse-PATH test FAILED:', err.message);
    process.exit(1);
  });
