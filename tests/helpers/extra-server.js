/**
 * Extra tmuxy servers beside the suite's own, on the same tmux socket.
 *
 * Some behaviour is a property of the server process — `--read-only`,
 * `--allowed-host` — so a test of it needs its own server on its own port.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WORKSPACE_ROOT } = require('./config');
const { tmuxEnv } = require('./tmux-socket');
const { waitForServer } = require('./browser');

/** The newest server binary on disk: the suite builds release, a dev loop builds debug. */
function serverBinary() {
  const built = ['release', 'debug']
    .map((profile) => path.join(WORKSPACE_ROOT, 'target', profile, 'tmuxy-server'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (built.length === 0) throw new Error('no tmuxy-server binary under target/');
  return built[0];
}

/** Start a server on `port` with `args`; resolves to a function that stops it. */
async function startExtraServer(port, args = []) {
  const stderr = fs.openSync(`/tmp/tmuxy-extra-server-${port}-stderr.log`, 'w');
  const server = spawn(serverBinary(), ['--port', String(port), ...args], {
    cwd: WORKSPACE_ROOT,
    stdio: ['ignore', 'ignore', stderr],
    env: tmuxEnv(),
  });
  await waitForServer(`http://localhost:${port}`, 30000);
  return () => server.kill();
}

module.exports = { startExtraServer };
