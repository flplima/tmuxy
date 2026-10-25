/**
 * Extra tmuxy servers beside the suite's own, on the same tmux socket.
 *
 * Some behaviour is a property of the server process — `--allowed-host`, a
 * config directory — so a test of it needs its own server on its own port.
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { WORKSPACE_ROOT } = require('./config');
const { tmuxEnv } = require('./tmux-socket');
const { waitForServer } = require('./browser');
const { serverBinary } = require('./server-binary');

/**
 * Start a server on `port` with `args`, and `env` on top of the suite's own;
 * resolves to a function that stops it.
 */
async function startExtraServer(port, args = [], env = {}) {
  const stderr = fs.openSync(`/tmp/tmuxy-extra-server-${port}-stderr.log`, 'w');
  const server = spawn(serverBinary(), ['--port', String(port), ...args], {
    cwd: WORKSPACE_ROOT,
    stdio: ['ignore', 'ignore', stderr],
    env: { ...tmuxEnv(), ...env },
  });
  await waitForServer(`http://localhost:${port}`, 30000);
  return () => server.kill();
}

module.exports = { startExtraServer };
