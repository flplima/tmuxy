/**
 * A stand-in for the tmux server a person's bare `tmux` talks to, and the
 * environment of a tmuxy (the web server, or the desktop app) launched beside
 * it the way a released one is.
 *
 * tmux keeps the `default` socket in `$TMUX_TMPDIR/tmux-<uid>/`, so both
 * servers get a directory of the test's own for it: the "user's" tmux is
 * `default` in there, and tmuxy, started with no `TMUX_SOCKET` (the launch
 * notice is for a tmuxy nobody pointed anywhere), runs on `tmuxy` in there
 * too. Neither is the developer's real server on either name.
 *
 * Shelling out lives here and not in the test file because `*.test.js` may
 * not use `child_process` (the user-path rule, enforced by ESLint). After the
 * user's server is started, every tmux command names its socket by path, so a
 * lost environment can never aim one at a real server.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startExtraServer } = require('./extra-server');
const { tmuxEnv } = require('./tmux-socket');

function ownTmuxWorld({ root, port = null }) {
  const tmpdir = path.join(root, 'tmp');
  const socketDir = path.join(tmpdir, `tmux-${process.getuid()}`);
  const usersSocket = path.join(socketDir, 'default');
  const stateDir = path.join(root, 'state');
  const env = tmuxEnv({
    state: stateDir,
    configHome: path.join(root, 'config'),
    data: path.join(root, 'data'),
    home: path.join(root, 'home'),
  });
  delete env.TMUX_SOCKET;
  env.TMUX_TMPDIR = tmpdir;
  const bin = process.env.TMUX_BIN || 'tmux';
  const tmux = (args) =>
    execFileSync(bin, args, { env, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }).trim();
  const onSocket = (name, args) => tmux(['-S', path.join(socketDir, name), ...args]);
  const usersTmux = (args) => onSocket('default', args).split('\n').filter(Boolean);
  let stopServer = null;

  return {
    url: port === null ? null : `http://localhost:${port}`,
    /** What a tmuxy launched into this world runs with: the desktop app's, or the web server's. */
    env,
    /** Where that tmuxy remembers the answer to the notice. */
    stateFile: path.join(stateDir, 'tmuxy.state.json'),
    /** What a session of the user's own tmux shows, so a page that opened it can be told. */
    marker: (session) => `own tmux session ${session}`,
    /**
     * Start the user's own tmux with `sessions`. Each prints its marker and
     * then runs a program that is not a shell: a shell killed while it starts
     * can hang on its terminal.
     */
    startUsersTmux(sessions) {
      fs.mkdirSync(tmpdir, { recursive: true });
      for (const name of sessions) {
        const program = `echo '${this.marker(name)}'; exec tail -f /dev/null`;
        tmux(['-L', 'default', '-f', '/dev/null', 'new-session', '-d', '-s', name, program]);
      }
      if (!fs.existsSync(usersSocket)) {
        throw new Error(`tmux did not put its default socket at ${usersSocket}`);
      }
    },
    /** The sessions the user's own tmux holds now. */
    usersSessions() {
      return usersTmux(['list-sessions', '-F', '#{session_name}']).sort();
    },
    /** The sessions of the user's own tmux that a client is attached to. */
    usersAttachedSessions() {
      return usersTmux(['list-clients', '-F', '#{client_session}']).sort();
    },
    /** Start the web server of this world, on its `port`. */
    async start() {
      fs.mkdirSync(stateDir, { recursive: true });
      stopServer = await startExtraServer(
        port,
        ['--no-auth'],
        env,
        path.join(root, 'server.stderr.log'),
      );
    },
    /** Stop the web server, if one was started, and both tmux servers of this world. */
    async stop() {
      if (stopServer) await stopServer();
      stopServer = null;
      for (const name of ['tmuxy', 'default']) {
        try {
          onSocket(name, ['kill-server']);
        } catch {
          // Already gone is the state wanted.
        }
      }
    },
  };
}

module.exports = { ownTmuxWorld };
