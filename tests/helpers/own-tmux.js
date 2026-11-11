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
 * not use `child_process` (the user-path rule, enforced by ESLint).
 * Every tmux command names its socket by path, the stand-in's start
 * included, and nothing is launched before the world has proved that a
 * socket NAME resolves inside it too (`proveNamesStayInside`): the tmuxy
 * under test can only be given the name `tmuxy`, which is also the live
 * app's.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startExtraServer } = require('./extra-server');
const { tmuxEnv } = require('./tmux-socket');

/**
 * The server-wide options a tmuxy that attaches is known to set: what
 * `tmuxy.essentials.conf` holds, and the two the monitor enforces on every
 * attach (`enforced_settings`, tmuxy-core). They are what it cannot work
 * without, and so the only ones an attach to the user's own server may
 * change. The README lists them for the user.
 */
const ESSENTIAL_OPTIONS = [
  'destroy-unattached',
  'exit-empty',
  'default-terminal',
  'terminal-overrides',
  'escape-time',
  'history-limit',
  'focus-events',
  'set-clipboard',
];

function ownTmuxWorld({ root, port = null }) {
  const tmpdir = path.join(root, 'tmp');
  const socketDir = path.join(tmpdir, `tmux-${process.getuid()}`);
  const usersSocket = path.join(socketDir, 'default');
  const stateDir = path.join(root, 'state');
  const env = tmuxEnv({
    state: stateDir,
    configHome: path.join(root, 'config'),
    data: path.join(root, 'data'),
    // `$HOME` stays the suite's own: the desktop app writes caches into it
    // as it exits, after a test has removed `root`.
  });
  delete env.TMUX_SOCKET;
  env.TMUX_TMPDIR = tmpdir;
  const bin = process.env.TMUX_BIN || 'tmux';
  /**
   * The names in play here are the live ones: `default` is the developer's
   * own tmux and `tmuxy` the app they may be sitting in. Only `TMUX_TMPDIR`
   * keeps this world's two servers apart from those, so nothing is launched
   * unless it is set, to a directory inside `root`, with no variable of a
   * live session beside it.
   */
  const assertIsolated = () => {
    const inside = env.TMUX_TMPDIR === tmpdir && tmpdir.startsWith(root + path.sep);
    const leaked = ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET'].filter((name) => name in env);
    if (!inside || leaked.length > 0) {
      throw new Error(
        `own-tmux world is not isolated: TMUX_TMPDIR=${env.TMUX_TMPDIR}, root=${root}, leaked=${leaked}`,
      );
    }
  };
  const tmux = (args) => {
    assertIsolated();
    return execFileSync(bin, args, { env, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }).trim();
  };
  const onSocket = (name, args) => tmux(['-S', path.join(socketDir, name), ...args]);
  /**
   * Proof, before anything is launched by name, that this tmux puts a named
   * socket inside `root` under this environment: a server on a name nobody
   * uses is started, and its socket file must be in the world's directory.
   */
  const proveNamesStayInside = () => {
    const name = `tmuxy-own-tmux-preflight-${process.pid}`;
    tmux(['-L', name, '-f', '/dev/null', 'new-session', '-d', '-s', 'p', 'tail -f /dev/null']);
    const inside = fs.existsSync(path.join(socketDir, name));
    try {
      tmux(['-L', name, 'kill-server']);
    } catch {
      // Already gone is the state wanted.
    }
    if (!inside) {
      throw new Error(`tmux did not put the socket ${name} inside ${socketDir}: not launching`);
    }
  };
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
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(socketDir, 0o700);
      proveNamesStayInside();
      // By path, never by the name `default`: the stand-in can only ever be
      // the file inside this world.
      for (const name of sessions) {
        const program = `echo '${this.marker(name)}'; exec tail -f /dev/null`;
        onSocket('default', ['-f', '/dev/null', 'new-session', '-d', '-s', name, program]);
      }
      if (!fs.existsSync(usersSocket)) {
        throw new Error(`tmux did not put its default socket at ${usersSocket}`);
      }
      // Settings of the user's own, none of them tmux's defaults, so a tmuxy
      // that attaches and overwrites one shows in `usersSettings`.
      onSocket('default', ['set-option', '-g', 'prefix', 'C-q']);
      onSocket('default', ['set-option', '-g', 'status-left', '[own] ']);
      onSocket('default', ['bind-key', '-T', 'prefix', 'F9', 'display-message', 'own binding']);
    },
    /**
     * The user's tmux as it is configured now: every key binding, every
     * hook, and every option but the ones a tmuxy that attaches is known to
     * set ({@link ESSENTIAL_OPTIONS}, its `@tmuxy-*` options and its command
     * aliases). Compared before and after an attach, it fails for anything
     * else tmuxy changes there.
     */
    usersSettings() {
      const kept = (line) =>
        !line.startsWith('@tmuxy-') &&
        !line.startsWith('command-alias[') &&
        !ESSENTIAL_OPTIONS.includes(line.split(/[ []/)[0]);
      const options = (flag) => usersTmux(['show-options', flag]).filter(kept);
      return {
        prefix: onSocket('default', ['show-options', '-gv', 'prefix']),
        keys: usersTmux(['list-keys']),
        hooks: usersTmux(['show-hooks', '-g']),
        sessionOptions: options('-g'),
        windowOptions: options('-gw'),
        serverOptions: options('-s'),
      };
    },
    /** The sessions the user's own tmux holds now. */
    usersSessions() {
      return usersTmux(['list-sessions', '-F', '#{session_name}']).sort();
    },
    /**
     * The sessions the tmuxy under test is attached to on ITS socket in this
     * world (`tmuxy`, inside `root`). A test asks as soon as the app shows a
     * pane: an empty answer means the app is attached somewhere else, which
     * with these socket names could be a live server, and the test must stop.
     */
    attachedInside() {
      try {
        return onSocket('tmuxy', ['list-clients', '-F', '#{client_session}'])
          .split('\n')
          .filter(Boolean)
          .sort();
      } catch {
        return [];
      }
    },
    /** Throws unless this world can only reach tmux servers inside its root. */
    assertIsolated,
    /** The sessions of the user's own tmux that a client is attached to. */
    usersAttachedSessions() {
      return usersTmux(['list-clients', '-F', '#{client_session}']).sort();
    },
    /** Start the web server of this world, on its `port`. */
    async start() {
      assertIsolated();
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
