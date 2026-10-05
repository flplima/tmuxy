/**
 * A tmuxy server of a test's own — its own tmux socket, port and state dir —
 * that can be stopped and started again.
 *
 * The suite's shared server (`jest.setup.js`) is exactly what a session
 * snapshot test must not touch: the feature under test is "kill the tmux
 * server and start tmuxy again", which would take every other test's panes
 * with it. So this one runs beside it, on a socket named by the caller, with
 * `TMUXY_STATE_DIR` pointed somewhere disposable so the snapshots it writes
 * never land in the developer's real state directory.
 *
 * Shelling out lives here and not in the test file because `*.test.js` may
 * not use `child_process` (the user-path rule, enforced by ESLint): a test
 * builds its session through the `tmuxy` CLI the user would use, and this is
 * the only place that CLI is executed on the isolated socket.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { WORKSPACE_ROOT } = require('./config');
const { waitForServer } = require('./browser');
const { serverBinary } = require('./server-binary');

const TMUXY_CLI = path.join(WORKSPACE_ROOT, 'bin/tmuxy-cli');

/** The environment every process on the isolated socket runs with. */
function isolatedEnv({ socket, stateDir }) {
  const env = { ...process.env, TMUX_SOCKET: socket, TMUXY_STATE_DIR: stateDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  // The shared suite's server runs with both off (helpers/tmux-socket.js, and
  // the CI job's env); this server exists to do exactly those two things.
  delete env.TMUXY_NO_SNAPSHOT;
  delete env.TMUXY_NO_RESTORE;
  return env;
}

/**
 * A handle on an isolated server. `start()` brings a server up on the socket
 * (creating the session if the tmux server is gone), `stop()` sends it
 * SIGTERM and waits for it to exit — which is the graceful shutdown a reboot
 * gives it — and `killTmux()` ends the tmux server itself, so the next
 * `start()` finds no session and has to restore one.
 */
function isolatedServer({ port, socket, session, stateDir }) {
  const env = isolatedEnv({ socket, stateDir });
  const url = `http://localhost:${port}`;
  let child = null;

  const cli = (args, opts = {}) => {
    try {
      return execFileSync(TMUXY_CLI, args, {
        env,
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      }).trim();
    } catch (error) {
      // What the CLI said is the diagnosis; `execFileSync`'s own message is
      // just the command line.
      throw new Error(`tmuxy ${args.join(' ')} failed: ${(error.stderr || '').toString().trim()}`);
    }
  };

  return {
    url,
    env,
    cli,
    async start(extraArgs = []) {
      fs.mkdirSync(stateDir, { recursive: true });
      const stderr = fs.openSync(path.join(stateDir, `server-${Date.now()}.stderr.log`), 'w');
      child = spawn(
        serverBinary(),
        ['--port', String(port), '--no-auth', '--session', session, ...extraArgs],
        { cwd: WORKSPACE_ROOT, stdio: ['ignore', 'ignore', stderr], env },
      );
      // The child holds its own copy; keeping ours open is an open handle
      // that stops jest from exiting.
      fs.closeSync(stderr);
      await waitForServer(url, 60000);
    },
    async stop() {
      if (!child) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      child = null;
    },
    /** End the tmux server on this socket; every session on it is gone. */
    killTmux() {
      try {
        cli(['run', 'kill-server']);
      } catch {
        // Already gone is the state wanted.
      }
    },
    /**
     * What the server said about snapshots, across every start: the only
     * account of a restore that stopped partway, and so what a failed wait
     * should print.
     */
    serverLog() {
      if (!fs.existsSync(stateDir)) return '';
      return fs
        .readdirSync(stateDir)
        .filter((name) => name.endsWith('.stderr.log'))
        .sort()
        .flatMap((name) => fs.readFileSync(path.join(stateDir, name), 'utf8').split('\n'))
        .filter((line) => /snapshot|restor|WARN|ERROR|panick/i.test(line))
        .slice(-30)
        .join('\n');
    },
    /** Where this server keeps its snapshots: one directory per socket. */
    snapshotDir: path.join(stateDir, 'sessions', socket),
    /** Snapshot files written so far, newest last. */
    snapshotFiles() {
      const dir = path.join(stateDir, 'sessions', socket);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).sort();
    },
  };
}

module.exports = { isolatedServer };
