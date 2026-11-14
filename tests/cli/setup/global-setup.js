/**
 * Before the first CLI test: a socket name and a tmux socket directory that
 * are this run's alone, checked and then handed to every test in the
 * environment. The run stops here if the socket could be anyone else's.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { liveSocketProblem } = require('../../helpers/live-socket-guard');
const { MOCK_TMUX, RESERVED, firstOnPath } = require('../helpers/seal');

/** The machine's real tmux, if it has one: what a leak would reach. */
function realTmux(searchPath = process.env.PATH) {
  const found = firstOnPath('tmux', searchPath);
  return found && fs.realpathSync(found) !== fs.realpathSync(MOCK_TMUX) ? found : null;
}

/**
 * The environment of the suite's own questions to a real tmux, which it
 * runs by its full path: sealed like any child's (`helpers/seal.js`), so the
 * answer can only come from the directory asked about.
 */
function probeEnv(socket, tmpdir) {
  return {
    PATH: `${path.dirname(MOCK_TMUX)}:${process.env.PATH}`,
    TMUX_SOCKET: socket,
    TMUX_TMPDIR: tmpdir,
  };
}

/** Whether a tmux server answers on `socket` in the socket directory `tmpdir`. */
function serverAnswers(socket, tmpdir, tmux = realTmux()) {
  if (!tmux) return false;
  const asked = spawnSync(tmux, ['-L', socket, 'list-sessions'], {
    env: probeEnv(socket, tmpdir),
    stdio: 'ignore',
    timeout: 10000,
  });
  return asked.status === 0;
}

/**
 * Why the run may not use `socket` in `tmpdir`, or `null`: the name is one
 * people work in, the directory is where live servers keep their sockets,
 * or a server the run did not start already answers there.
 */
function suiteSocketProblem({ socket, tmpdir, shellTmux = process.env.TMUX, answers }) {
  const liveDir = fs.realpathSync(process.env.TMUX_TMPDIR || '/tmp');
  if (fs.realpathSync(tmpdir) === liveDir) {
    return `${tmpdir} is the directory live tmux servers keep their sockets in`;
  }
  return liveSocketProblem({
    socket,
    shellTmux,
    reserved: RESERVED,
    answers: answers ?? ((name) => serverAnswers(name, tmpdir)),
  });
}

/**
 * A directory and a socket name for the run. Short ones: a socket's path
 * has about a hundred characters in all (104 on macOS, where the per-user
 * temp dir alone takes half of them), and the one test that starts a real
 * tmux server needs its socket to fit. So the directory goes under `/tmp`.
 */
function makeSuite() {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return {
    tmpdir: fs.mkdtempSync(path.join(base, 'tmuxy-cli-')),
    socket: `tmuxy-cli-${process.pid}-${crypto.randomBytes(2).toString('hex')}`,
  };
}

async function globalSetup() {
  const { socket, tmpdir } = makeSuite();
  const problem = suiteSocketProblem({ socket, tmpdir });
  if (problem) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    throw new Error(`tests/cli will not run: ${problem}.`);
  }
  process.env.TMUXY_CLI_SUITE_SOCKET = socket;
  process.env.TMUXY_CLI_SUITE_TMPDIR = tmpdir;
}

module.exports = globalSetup;
Object.assign(module.exports, {
  makeSuite,
  probeEnv,
  realTmux,
  serverAnswers,
  suiteSocketProblem,
});
