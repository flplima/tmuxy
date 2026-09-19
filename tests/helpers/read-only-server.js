/**
 * A second, `--read-only` tmuxy server beside the suite's own.
 *
 * Read-only is a property of the server process, so a viewer needs its own
 * server on its own port, attached to the same tmux socket as the one the
 * suite writes through.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TMUXY_PORT, WORKSPACE_ROOT } = require('./config');
const { tmuxEnv } = require('./tmux-socket');
const { waitForServer } = require('./browser');

// Well clear of the suite's port: a `--dev` server also takes the two after its own.
const READ_ONLY_PORT = parseInt(process.env.TMUXY_READ_ONLY_PORT || String(TMUXY_PORT + 100), 10);
const READ_ONLY_URL = `http://localhost:${READ_ONLY_PORT}`;

/** The newest server binary on disk: the suite builds release, a dev loop builds debug. */
function serverBinary() {
  const built = ['release', 'debug']
    .map((profile) => path.join(WORKSPACE_ROOT, 'target', profile, 'tmuxy-server'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (built.length === 0) throw new Error('no tmuxy-server binary under target/');
  return built[0];
}

/** Start the read-only server; resolves to a function that stops it. */
async function startReadOnlyServer() {
  const stderr = fs.openSync('/tmp/tmuxy-read-only-server-stderr.log', 'w');
  const server = spawn(serverBinary(), ['--port', String(READ_ONLY_PORT), '--read-only'], {
    cwd: WORKSPACE_ROOT,
    stdio: ['ignore', 'ignore', stderr],
    env: tmuxEnv(),
  });
  await waitForServer(READ_ONLY_URL, 30000);
  return () => server.kill();
}

module.exports = { READ_ONLY_URL, startReadOnlyServer };
