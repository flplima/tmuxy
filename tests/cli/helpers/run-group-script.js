/**
 * Drive `packages/tmuxy-cli/bin/tmuxy/pane-group <verb>` with a stub server binary.
 *
 * The script is a name for the server binary's `group` verb; what it owes
 * its callers is the hand-off itself — the verb, the arguments untouched,
 * the scripts directory for the pane-died hook, and the binary's own output
 * and exit status. The stub prints what it was handed and exits with
 * `STUB_EXIT`.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scriptEnv, withScratchDir } = require('./env');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'packages/tmuxy-cli/bin/tmuxy');

/**
 * @param {string} verb - The group verb, e.g. `move`
 * @param {string[]} args - The verb's arguments
 * @param {Record<string, string>} [env] - Extra environment
 * @returns {{ stdout: string, stderr: string, exitCode: number | null }}
 */
function runGroupScript(verb, args, env = {}) {
  return withScratchDir('tmuxy-group-', (dir) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'tmuxy-server'),
      '#!/bin/bash\necho "server $* [scripts=$TMUXY_SCRIPTS_DIR]"\nexit "${STUB_EXIT:-0}"\n',
      { mode: 0o755 },
    );
    const base = scriptEnv(dir);
    const result = spawnSync('bash', [path.join(SCRIPTS_DIR, 'pane-group'), verb, ...args], {
      encoding: 'utf8',
      env: { ...base, PATH: `${bin}:${base.PATH}`, ...env },
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr, exitCode: result.status };
  });
}

/**
 * Run `pane-group <verb>` from a copy of the scripts in a dev tree with
 * nothing installed: no published binary, no server on PATH, no desktop app's
 * launcher — only a stub `target/debug/tmuxy-server` at the tree's root. The
 * copy keeps the scripts' depth below the repo root, which is what the lookup
 * goes by. The stub prints `dev build …`.
 *
 * @param {string} verb - The group verb, e.g. `next`
 * @param {string[]} args - The verb's arguments
 * @returns {{ stdout: string, stderr: string, exitCode: number | null }}
 */
function runGroupScriptInBareTree(verb, args) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-devtree-'));
  try {
    const scripts = path.join(repo, path.relative(REPO_ROOT, SCRIPTS_DIR));
    fs.cpSync(SCRIPTS_DIR, scripts, { recursive: true });
    fs.mkdirSync(path.join(repo, 'target', 'debug'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'target', 'debug', 'tmuxy-server'),
      '#!/bin/bash\necho "dev build $*"\n',
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [path.join(scripts, 'pane-group'), verb, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: repo, XDG_CONFIG_HOME: path.join(repo, 'cfg') },
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr, exitCode: result.status };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

module.exports = { runGroupScript, runGroupScriptInBareTree };
