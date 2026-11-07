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
const { execFileSync } = require('child_process');
const { TMUXY_CLI } = require('./config');
const { startExtraServer } = require('./extra-server');
const { tmuxRunAsOperator } = require('./cli');
const { tmuxEnv } = require('./tmux-socket');

/**
 * The environment every process on the isolated socket runs with: its own
 * config, data and home dirs beside the state dir, and snapshots on, which is
 * what this server is for. In the developer's own data dir the installed app
 * rewrites the scripts with ITS build's copies on every `tmuxy` it answers,
 * so the panes would run an older build's scripts, not the ones under test.
 */
function isolatedEnv({ socket, stateDir }) {
  const root = path.dirname(stateDir);
  return tmuxEnv({
    socket,
    state: stateDir,
    configHome: path.join(root, 'config'),
    data: path.join(root, 'data'),
    home: path.join(root, 'home'),
    snapshots: true,
  });
}

/**
 * A handle on an isolated server. `start()` brings a server up on the socket
 * (creating the session if the tmux server is gone), `stop()` sends it
 * SIGTERM and waits for it to exit — which is the graceful shutdown a reboot
 * gives it — and `killTmux()` ends the tmux server itself, so the next
 * `start()` finds no session and has to restore one.
 */
function isolatedServer({ port, socket, stateDir }) {
  const env = isolatedEnv({ socket, stateDir });
  const url = `http://localhost:${port}`;
  let stopServer = null;

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
      stopServer = await startExtraServer(
        port,
        ['--no-auth', ...extraArgs],
        env,
        path.join(stateDir, `server-${Date.now()}.stderr.log`),
      );
    },
    async stop() {
      if (!stopServer) return;
      const stopping = stopServer;
      stopServer = null;
      if (!(await stopping()))
        throw new Error(`the server on ${url} did not exit on SIGTERM\n${this.serverLog()}`);
    },
    /**
     * A tmux command the person at the keyboard would run, past `tmuxy run`'s
     * refusals (`tmuxRunAsOperator`), on this server's socket.
     */
    asOperator(command) {
      return tmuxRunAsOperator(command, env);
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

/** The snapshot JSON, without the one field a save is allowed to change. */
function shapeOf(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete snapshot.saved_at;
  return snapshot;
}

/**
 * A tmux layout reduced to its tree: `d363,139x27,0,0[139x13,0,0,0,…]`
 * becomes `P[P,P]`. The checksum, every size and every pane id are the
 * client's and tmux's to assign, and a restored session is sized by the
 * client that attaches to it next — the splits are what was saved.
 */
function layoutTree(layout) {
  return layout.replace(/^[0-9a-f]{4},/, '').replace(/\d+x\d+,\d+,\d+(,\d+)?/g, 'P');
}

/**
 * What one snapshot must share with another for the session to count as the
 * same one: windows by index, type, parent and layout tree; panes by index,
 * directory, tags and the program's own word. Not `command`: that is what
 * `ps` saw in the foreground at that moment, and the restore OFFERS it at the
 * prompt rather than running it, so a save after the restore sees a shell.
 */
function comparable(shape) {
  return {
    windows: shape.windows.map((w) => ({
      ...w,
      layout: layoutTree(w.layout),
      // `offer` is checked apart.
      panes: w.panes.map(({ command, offer, ...pane }) => pane),
    })),
    // The group's member parked out of view comes back parked, in its group.
    hidden: (shape.hidden ?? []).map(({ command, offer, ...member }) => member),
  };
}

module.exports = { isolatedServer, shapeOf, comparable };
