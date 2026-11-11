/**
 * After the last CLI test: the run's socket directory must hold no socket.
 * The suite only ever runs the mock, which makes none, so a socket here is a
 * real tmux server some test started. It is killed, and the run fails.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isSocketFile } = require('../../helpers/live-socket-guard');
const { probeEnv, realTmux } = require('./global-setup');

/** Every socket under `tmpdir` (tmux keeps them in `tmux-<uid>/`). */
function socketsIn(tmpdir) {
  const found = [];
  for (const entry of fs.readdirSync(tmpdir, { recursive: true })) {
    const file = path.join(tmpdir, String(entry));
    if (isSocketFile(file)) found.push(file);
  }
  return found;
}

/** Kill the servers behind `sockets`, which are the run's own by being in `tmpdir`. */
function killStrays(sockets, tmpdir, tmux) {
  if (!tmux) return;
  for (const socket of sockets) {
    spawnSync(tmux, ['-S', socket, 'kill-server'], {
      env: probeEnv(socket, tmpdir),
      stdio: 'ignore',
      timeout: 10000,
    });
  }
}

/**
 * Remove the run's directory `tmpdir`, killing whatever serves a socket in
 * it, and throw if there was one. tmux leaves its socket file behind when
 * its server goes, so a server that came and went is caught too.
 */
function sweep(tmpdir, tmux = realTmux()) {
  if (!tmpdir || !fs.existsSync(tmpdir)) return;
  const strays = socketsIn(tmpdir);
  killStrays(strays, tmpdir, tmux);
  fs.rmSync(tmpdir, { recursive: true, force: true });
  if (strays.length > 0) {
    throw new Error(
      `tests/cli started a real tmux server (${strays.join(', ')}): a test reached past the mock. ` +
        'It was on the run’s own socket and has been killed; find the child process that ran it.',
    );
  }
}

async function globalTeardown() {
  sweep(process.env.TMUXY_CLI_SUITE_TMPDIR);
}

module.exports = globalTeardown;
Object.assign(module.exports, { killStrays, socketsIn, sweep });
