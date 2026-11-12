/**
 * The environment a CLI script runs under in these tests: nothing of the
 * developer's shell that would aim a script at their own session or the
 * installed app (`scrubbedEnv`), `HOME` a scratch directory so tmuxy's dirs
 * resolve inside it, and whatever the test names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrubbedEnv } = require('../../helpers/tmux-socket');
const { seal, suite } = require('./seal');

const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/**
 * The environment of any child a CLI test starts: the shell's, without what
 * would aim a tmux command at a session someone works in, the mocks first on
 * `PATH`, and the seal (`./seal.js`): the run's own socket and tmux socket
 * directory. A test adds to it; the seal's own variables it cannot move
 * anywhere live, since a child with a broken seal is not started.
 *
 * tmuxy exports `TMUX_BIN` into every pane it runs, and the CLI runs that
 * binary rather than the `tmux` on PATH. Inherited, it took the mock's
 * place: a suite run from a tmuxy pane sent the CLI's tmux commands to the
 * real tmux. It is dropped here with the rest.
 *
 * @param {Record<string, string>} [env] - What the test sets, over the rest
 * @returns {Record<string, string>}
 */
function sealedEnv(env = {}) {
  const inherited = scrubbedEnv();
  delete inherited.TMUX_BIN;
  delete inherited.TMUX_TMPDIR;
  return { ...inherited, PATH: `${MOCKS_DIR}:${process.env.PATH}`, ...seal(), ...env };
}

/**
 * {@link sealedEnv} for a CLI script: `HOME` a scratch directory too, so
 * tmuxy's dirs resolve inside it.
 *
 * @param {string} home - The scratch directory the script takes as `HOME`
 * @param {Record<string, string>} [env] - What the test sets, over the rest
 * @returns {Record<string, string>} The mocks first on PATH, nothing leaked, and no `TMUX_BIN` to run in their place
 */
function scriptEnv(home, env = {}) {
  return sealedEnv({ HOME: home, ...env });
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

/**
 * The run's own socket name: what every CLI under test is told to use. The
 * global setup made it before any test file loads.
 */
const SOCKET = suite().socket;

module.exports = {
  MOCKS_DIR,
  SOCKET,
  scriptEnv,
  sealedEnv,
  withScratchDir,
};
