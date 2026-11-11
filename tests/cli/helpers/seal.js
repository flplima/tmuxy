/**
 * What keeps the CLI suite off every tmux server but its own mock.
 *
 * The suite runs the real CLI scripts, and those end in `kill-pane`,
 * `kill-window` and `kill-server`. Run from a pane of a live tmuxy, one leak
 * is enough to close the tabs the developer works in: an inherited
 * `TMUX_BIN`, a `PATH` without the mock, a child handed the shell's own
 * environment. So the suite has a socket and a tmux socket directory nobody
 * else has (`setup/global-setup.js`), and no child process starts unless its
 * environment is sealed to them (`setup/seal-children.js`):
 *
 *   - `TMUX_TMPDIR` is the suite's directory, so even a real tmux given a
 *     socket NAME looks for it there, where no live server is;
 *   - `TMUX_SOCKET` is set, and is not a socket people work in, so nothing
 *     falls back to `$TMUX` or to the default;
 *   - `TMUX_BIN` is unset and the first `tmux` on `PATH` is the mock;
 *   - `TMUX`, where a test sets one to play a pane, names no socket on disk.
 */

const fs = require('fs');
const path = require('path');
const {
  isSocketFile,
  liveSocketProblem,
  socketOfTmuxEnv,
} = require('../../helpers/live-socket-guard');

const MOCK_TMUX = path.resolve(__dirname, '../mocks/tmux');

/** The E2E suite's socket: another run's, not this one's. */
const RESERVED = ['tmuxy-test'];

/**
 * The run's own socket name and tmux socket directory, made by the global
 * setup and handed down in the environment.
 *
 * @returns {{ socket: string, tmpdir: string }}
 */
function suite() {
  const socket = process.env.TMUXY_CLI_SUITE_SOCKET;
  const tmpdir = process.env.TMUXY_CLI_SUITE_TMPDIR;
  if (!socket || !tmpdir) {
    throw new Error(
      'the CLI suite has no socket of its own: run it through tests/cli/jest.config.js, whose global setup makes one',
    );
  }
  return { socket, tmpdir };
}

/** The first `name` on `searchPath`, as a shell would find it. */
function firstOnPath(name, searchPath = '') {
  for (const dir of searchPath.split(':').filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

function isTheMock(file) {
  try {
    return fs.realpathSync(file) === fs.realpathSync(MOCK_TMUX);
  } catch {
    return false;
  }
}

/**
 * Why a child process may not start with `env`, or `null` when it may.
 *
 * @param {Record<string, string | undefined> | undefined} env - The child's
 *   whole environment; `undefined` when it would inherit this process's
 * @param {{ socket: string, tmpdir: string }} [own] - The run's socket and directory
 * @returns {string | null}
 */
function sealProblem(env, own = suite()) {
  if (!env) {
    return 'it was given no environment of its own, so it would inherit the shell’s, $TMUX and all';
  }
  if (env.TMUX_TMPDIR !== own.tmpdir) {
    return 'TMUX_TMPDIR is not the suite’s own directory, so a real tmux would look for sockets where live servers keep theirs';
  }
  if (env.TMUX_BIN) {
    return `TMUX_BIN names a tmux (${env.TMUX_BIN}) the CLI would run in the mock’s place`;
  }
  const tmux = firstOnPath('tmux', env.PATH);
  if (tmux && !isTheMock(tmux)) {
    return `the first tmux on its PATH is ${tmux}, not the mock`;
  }
  const socket = env.TMUX_SOCKET;
  const named = liveSocketProblem({ socket, shellTmux: '', reserved: RESERVED });
  if (named) return `TMUX_SOCKET: ${named}`;
  if (socket.includes('/') && !path.resolve(socket).startsWith(`${own.tmpdir}${path.sep}`)) {
    return `TMUX_SOCKET is a path outside the suite’s own directory (${socket})`;
  }
  const played = socketOfTmuxEnv(env.TMUX);
  if (played && isSocketFile(played)) {
    return `TMUX names a socket that exists (${played})`;
  }
  return null;
}

/** The variables that seal an environment to the run's socket and directory. */
function seal() {
  const { socket, tmpdir } = suite();
  return { TMUX_SOCKET: socket, TMUX_TMPDIR: tmpdir };
}

/**
 * A `$TMUX` for a test that plays a pane of the server on `socket`: a path
 * in the suite's directory, where nothing listens.
 */
function playedTmux(socket = suite().socket) {
  return `${path.join(suite().tmpdir, socket)},4242,0`;
}

const CHILD_STARTERS = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
];

/**
 * Put the seal in front of every way this process starts a child, and
 * return the function that takes it off again. A child whose environment is
 * not sealed is never started: the call throws, naming what is wrong.
 *
 * @param {object} [childProcess] - The module to guard (the real one)
 * @returns {() => void}
 */
function sealChildProcesses(childProcess = require('child_process')) {
  const real = {};
  for (const name of CHILD_STARTERS) {
    real[name] = childProcess[name];
    childProcess[name] = function sealed(...args) {
      const options = args.find(
        (arg, i) => i > 0 && arg && typeof arg === 'object' && !Array.isArray(arg),
      );
      const problem = sealProblem(options?.env);
      if (problem) {
        throw new Error(
          `tests/cli: \`${String(args[0])}\` was not started: ${problem}. ` +
            'Build a child’s environment with scriptEnv() or sealedEnv() (tests/cli/helpers/env.js).',
        );
      }
      return real[name].apply(this, args);
    };
  }
  return () => Object.assign(childProcess, real);
}

module.exports = {
  MOCK_TMUX,
  RESERVED,
  firstOnPath,
  playedTmux,
  seal,
  sealChildProcesses,
  sealProblem,
  suite,
};
