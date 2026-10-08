/**
 * Drive a `bin/tmuxy/pane-group-*` script with a stub server binary.
 *
 * The scripts are names for the server binary's `group` verb; what they owe
 * their callers is the hand-off itself — the verb, the arguments untouched,
 * the scripts directory for the pane-died hook, and the binary's own output
 * and exit status. The stub prints what it was handed and exits with
 * `STUB_EXIT`. With `standalone`, a stub `tmuxy-group` (the v86 guest's
 * binary) is on PATH too, and prints `standalone …` instead.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname, '../../../bin/tmuxy');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/**
 * @param {string} script - Script name, e.g. `pane-group-move`
 * @param {string[]} args - The script's arguments
 * @param {Record<string, string>} [env] - Extra environment
 * @param {{ standalone?: boolean }} [opts]
 * @returns {{ stdout: string, stderr: string, exitCode: number | null }}
 */
function runGroupScript(script, args, env = {}, { standalone = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-group-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'tmuxy-server'),
      '#!/bin/bash\necho "server $* [scripts=$TMUXY_SCRIPTS_DIR]"\nexit "${STUB_EXIT:-0}"\n',
      { mode: 0o755 },
    );
    if (standalone) {
      fs.writeFileSync(
        path.join(dir, 'tmuxy-group'),
        '#!/bin/bash\necho "standalone $* [scripts=$TMUXY_SCRIPTS_DIR]"\nexit "${STUB_EXIT:-0}"\n',
        { mode: 0o755 },
      );
    }
    // A shell inside tmuxy inherits the binary the running build published;
    // the stub must win unless a test publishes one itself.
    const base = { ...process.env };
    delete base.TMUXY_SERVER_BIN;
    delete base.TMUXY_SERVER_SUBCOMMAND;
    const result = spawnSync('bash', [path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf8',
      env: { ...base, PATH: `${dir}:${MOCKS_DIR}:${process.env.PATH}`, ...env },
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr, exitCode: result.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runGroupScript };
