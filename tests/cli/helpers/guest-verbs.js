/**
 * A machine laid out as the in-browser guests are: the CLI and its scripts,
 * a `tmuxy-verbs` built the way the guests build it (without the `native`
 * feature, `packages/tmuxy-ui/scripts/lib/guest.mjs`), the mock tmux, and no
 * server anywhere: none on PATH, no build tree around the scripts, no
 * published binary, no desktop launcher.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/** Build the guest's `tmuxy-verbs` and return where cargo put it. */
function buildGuestVerbs() {
  const out = execFileSync(
    process.env.CARGO ?? 'cargo',
    [
      'build',
      '-p',
      'tmuxy-verbs',
      '--bin',
      'tmuxy-verbs',
      '--no-default-features',
      '--message-format=json-render-diagnostics',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const artifact = out
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find((msg) => msg.reason === 'compiler-artifact' && msg.target?.name === 'tmuxy-verbs');
  if (!artifact?.executable) throw new Error('cargo built no tmuxy-verbs executable');
  return artifact.executable;
}

/**
 * `runScript(name, args, env)` runs one of the CLI's helper scripts as
 * run-shell runs it: bash, outside any pane.
 *
 * @returns {{ cli: string, path: string, home: string, runScript: Function, remove: () => void }}
 */
function guestMachine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-guest-'));
  const cliBin = path.join(root, 'packages', 'tmuxy-cli', 'bin');
  fs.cpSync(path.join(REPO_ROOT, 'packages', 'tmuxy-cli', 'bin'), cliBin, { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(buildGuestVerbs(), path.join(bin, 'tmuxy-verbs'));
  fs.chmodSync(path.join(bin, 'tmuxy-verbs'), 0o755);
  fs.symlinkSync(path.join(MOCKS_DIR, 'tmux'), path.join(bin, 'tmux'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const machinePath = `${bin}:/usr/bin:/bin`;
  const runScript = (name, args, env = {}) => {
    const result = spawnSync('bash', [path.join(cliBin, 'tmuxy', name), ...args], {
      encoding: 'utf8',
      env: { PATH: machinePath, HOME: home, ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
  };
  return {
    cli: path.join(cliBin, 'tmuxy-cli'),
    path: machinePath,
    home,
    runScript,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

module.exports = { guestMachine };
