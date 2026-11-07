/**
 * tmuxy servers of a test's own, beside the suite's shared one.
 *
 * Some behaviour is a property of the server process (`--allowed-host`, a
 * config directory, a session snapshot taken at shutdown), so a test of it
 * needs a server on a port of its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WORKSPACE_ROOT, serverBinary, waitBudget } = require('./config');
const { tmuxEnv } = require('./tmux-socket');
const { waitForServer } = require('./browser');

/**
 * Start a server on `port` with `args` in `env` (the suite's own unless
 * given), its stderr in `log`; resolves once it answers, to a function that
 * sends it SIGTERM and resolves to whether it exited within the budget.
 */
async function startExtraServer(
  port,
  args = [],
  env = tmuxEnv(),
  log = path.join(os.tmpdir(), `tmuxy-extra-server-${port}.stderr.log`),
) {
  const stderr = fs.openSync(log, 'w');
  const server = spawn(serverBinary(), ['--port', String(port), ...args], {
    cwd: WORKSPACE_ROOT,
    stdio: ['ignore', 'ignore', stderr],
    env,
  });
  // The child holds its own copy; keeping ours open is an open handle that
  // stops jest from exiting.
  fs.closeSync(stderr);
  const exited = new Promise((resolve) => server.once('exit', () => resolve(true)));
  await waitForServer(`http://localhost:${port}`, 60000);
  return async () => {
    server.kill('SIGTERM');
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), waitBudget(10000));
    });
    const done = await Promise.race([exited, late]);
    clearTimeout(timer);
    return done;
  };
}

module.exports = { startExtraServer };
