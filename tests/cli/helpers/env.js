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

const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/**
 * @param {string} home - The scratch directory the script takes as `HOME`
 * @param {Record<string, string>} [env] - What the test sets, over the rest
 * @returns {Record<string, string>} The mocks first on PATH, nothing leaked, and no `TMUX_BIN` to run in their place
 */
function scriptEnv(home, env = {}) {
  const inherited = scrubbedEnv();
  // tmuxy exports `TMUX_BIN` into every pane it runs, and the CLI runs that
  // binary rather than the `tmux` on PATH. Inherited here, it took the mock's
  // place: a suite run from a tmuxy pane sent the CLI's tmux commands to the
  // real tmux, on whatever socket the test named.
  delete inherited.TMUX_BIN;
  return { ...inherited, HOME: home, PATH: `${MOCKS_DIR}:${process.env.PATH}`, ...env };
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
