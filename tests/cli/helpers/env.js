/**
 * The environment a CLI script runs under in these tests.
 *
 * The suite is run from a shell inside tmux, and often inside tmuxy, whose
 * environment points at the developer's own tmux server (`TMUX`, `TMUX_PANE`,
 * `TMUX_SOCKET`), at the binary the running build published
 * (`TMUXY_SERVER_BIN`, `TMUXY_SERVER_SUBCOMMAND`) and at its config chain and
 * dirs (`TMUXY_DATA_DIR`, `TMUXY_STATE_DIR`, `TMUXY_ENTRY_CONF`, `XDG_*`).
 * A script that inherits any of them acts on the developer's session or
 * finds the installed app. None is inherited; `HOME` is a scratch directory,
 * so tmuxy's dirs resolve inside it; a test names whatever it needs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOCKS_DIR = path.resolve(__dirname, '../mocks');

const LEAKED = [
  'TMUX',
  'TMUX_PANE',
  'TMUX_SOCKET',
  'TMUXY_SERVER_BIN',
  'TMUXY_SERVER_SUBCOMMAND',
  'TMUXY_DATA_DIR',
  'TMUXY_STATE_DIR',
  'TMUXY_ENTRY_CONF',
  'TMUXY_CALLER_PANE',
  'TMUXY_SCRIPTS_DIR',
  'TMUXY_PASSWORD',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
];

/**
 * @param {string} home - The scratch directory the script takes as `HOME`
 * @param {Record<string, string>} [env] - What the test sets, over the rest
 * @returns {Record<string, string>} The mocks first on PATH, nothing leaked
 */
function scriptEnv(home, env = {}) {
  const base = { ...process.env };
  for (const name of LEAKED) delete base[name];
  return { ...base, HOME: home, PATH: `${MOCKS_DIR}:${process.env.PATH}`, ...env };
}

/**
 * Run `fn` with a fresh scratch directory, removed afterwards.
 *
 * @template T
 * @param {string} prefix - The directory's name prefix
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
function withScratchDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

module.exports = { MOCKS_DIR, scriptEnv, withScratchDir };
