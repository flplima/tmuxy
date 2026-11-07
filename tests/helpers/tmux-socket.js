const fs = require('fs');
const os = require('os');
const path = require('path');
/**
 * The tmux socket, environment and dirs every test helper shares.
 *
 * The tmuxy server always talks to a dedicated tmux socket: `TMUX_SOCKET`
 * when set (a value containing a slash is a full socket path → `-S`, else a
 * socket name → `-L`), otherwise the `tmuxy` socket name (see tmuxy-core
 * `tmux_socket()` / `tmux_socket_args()`). Every test helper that shells out
 * to tmux must target the same socket, or it silently operates on the
 * default server: sessions "don't exist", kill-session cleans nothing
 * (leaking panes across tests), and list queries return the wrong world.
 */

/**
 * The socket the E2E suite owns, when `TMUX_SOCKET` says nothing else.
 *
 * One socket per environment: `tmuxy` belongs to a released build, `tmuxy-dev`
 * to `bin/dev-server`, and `tmuxy-test` to this suite. It creates and kills sessions,
 * panes and windows by the hundred, and a tmux tool is normally developed from
 * inside the very session it would be tearing down — a socket of its own means
 * a suite run cannot touch the dev server or the session the developer sits in.
 *
 * The server under test must be on this socket too — it is the other half of
 * every round trip. The suite starts its own that way (jest.setup.js); a
 * server started by hand needs `TMUX_SOCKET` set to match.
 */
const DEFAULT_SOCKET = 'tmuxy-test';

/** The socket name or path the tmuxy server under test uses. */
function tmuxSocket() {
  return process.env.TMUX_SOCKET || DEFAULT_SOCKET;
}

/**
 * What a developer's shell carries that no child of the suite may inherit.
 * The suite runs from a shell inside tmux, often inside tmuxy, so these point
 * at the developer's own tmux server (`TMUX`, `TMUX_PANE`, `TMUX_SOCKET`), at
 * the binary the running build published (`TMUXY_SERVER_BIN`,
 * `TMUXY_SERVER_SUBCOMMAND`: handed to a tmux server at birth, every script it
 * runs would call that build's verbs), at its config chain and dirs, and at
 * its login (`TMUXY_PASSWORD`: a server under test that reads it answers every
 * request 401). An AppImage's runtime exports `APPIMAGE`, `APPDIR`, `ARGV0`
 * and `OWD` into the tmux server it starts, so every pane of an installed
 * tmuxy has them; a server that inherits `APPIMAGE` takes itself for that
 * install (`invoked_exe`) and publishes ITS binary to the suite's tmux.
 */
const DEVELOPER_ENV = [
  'TMUX',
  'TMUX_PANE',
  'TMUX_SOCKET',
  'TMUXY_SERVER_BIN',
  'TMUXY_SERVER_SUBCOMMAND',
  'TMUXY_DATA_DIR',
  'TMUXY_STATE_DIR',
  'TMUXY_ENTRY_CONF',
  'TMUXY_CALLER_PANE',
  'TMUXY_PASSWORD',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPIMAGE',
  'APPDIR',
  'ARGV0',
  'OWD',
];

/** `process.env` without {@link DEVELOPER_ENV}. */
function scrubbedEnv() {
  const env = { ...process.env };
  for (const name of DEVELOPER_ENV) delete env[name];
  return env;
}

/**
 * Environment for any tmux, tmuxy-CLI or tmuxy-server child process: the
 * suite's own socket and dirs unless the caller names others (a server of a
 * test's own, `snapshots` when it is there to save and restore sessions).
 *
 * `packages/tmuxy-cli/bin/tmuxy-cli` derives its socket from `$TMUX` whenever
 * `TMUX_SOCKET` is unset, so an inherited `$TMUX` would aim every mutating
 * command at the server the developer's shell is attached to while reads hit
 * the test socket. Pinned here, per child, rather than by mutating
 * `process.env`: Jest gives each test context a copy of the environment, so
 * those mutations do not reliably reach `child_process`.
 */
function tmuxEnv({
  socket = tmuxSocket(),
  state = stateDir(),
  configHome: config = configHome(),
  data = dataDir(),
  home = homeDir(),
  snapshots = false,
} = {}) {
  const env = {
    ...scrubbedEnv(),
    TMUX_SOCKET: socket,
    TMUXY_STATE_DIR: state,
    // The developer's own ~/.config/tmuxy and ~/.local/share/tmuxy, never:
    // the suite runs this branch's build, which would migrate the one (and
    // write its starter) and re-mirror the other's scripts and confs under the
    // installed app's feet, and a test would see whatever the developer put
    // there. The UI names the scripts by the data dir the chain publishes to
    // tmux, so the server under test runs the ones it mirrored here.
    XDG_CONFIG_HOME: config,
    TMUXY_DATA_DIR: data,
  };
  // The shared server neither saves nor rebuilds sessions: a suite that kills
  // a session and makes another of the same name must get an empty one, not
  // the last one's tabs.
  if (snapshots) {
    delete env.TMUXY_NO_SNAPSHOT;
    delete env.TMUXY_NO_RESTORE;
  } else {
    Object.assign(env, { TMUXY_NO_SNAPSHOT: '1', TMUXY_NO_RESTORE: '1' });
  }
  return isolateHome(env, home);
}

/**
 * Give `env` a `$HOME` of the suite's own. The developer's, never: a pane's
 * shell would run their rc (a prompt hook that retitles every pane, say), and
 * anything that falls back to `~/.local/state/tmuxy` would write into the
 * installed app's state. The rc files are there and empty, so zsh does not
 * start its new-user wizard in every pane.
 */
function isolateHome(env, home) {
  fs.mkdirSync(home, { recursive: true });
  for (const rc of ['.zshrc', '.bashrc']) {
    const file = path.join(home, rc);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }
  return Object.assign(env, { HOME: home });
}

/** The suite's own `$HOME`, beside its state dir. */
function homeDir() {
  return path.join(os.tmpdir(), `tmuxy-e2e-home-${tmuxSocket().replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

/**
 * Where the server under test keeps its state (session snapshots above all).
 *
 * The developer's own, never: the server snapshots its session on every
 * change and rebuilds a missing one from the latest snapshot at start, so a
 * run that wrote into the real state dir would hand the NEXT run's fresh
 * `tmuxy-test` server the previous run's tabs — every test that expects an
 * empty first tab then starts on someone else's layout. One scratch dir per
 * socket, under the OS temp dir; `jest.setup.js` wipes it before it starts a
 * server.
 */
function stateDir() {
  return (
    process.env.TMUXY_STATE_DIR ||
    path.join(os.tmpdir(), `tmuxy-e2e-state-${tmuxSocket().replace(/[^A-Za-z0-9_-]/g, '_')}`)
  );
}

/** The suite's own `$XDG_CONFIG_HOME`, beside its state dir. */
function configHome() {
  return path.join(os.tmpdir(), `tmuxy-e2e-config-${tmuxSocket().replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

/** The suite's own data dir, beside its state dir. */
function dataDir() {
  return path.join(os.tmpdir(), `tmuxy-e2e-data-${tmuxSocket().replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

/**
 * The tmux the suite runs: `TMUX_BIN` when set, as the server under test reads
 * it (tmuxy-core `tmux_path()`) and the CLI does, so a run can target a
 * side-installed tmux (the 3.2a floor, say) without touching the one on PATH.
 */
function tmuxBin() {
  return process.env.TMUX_BIN || 'tmux';
}

/** `tmux -L <name>` / `tmux -S <path>` prefix for building shell commands. */
function tmuxCmd() {
  const socket = tmuxSocket();
  const bin = tmuxBin();
  const word = /^[\w./@+-]+$/.test(bin) ? bin : `'${bin.replace(/'/g, `'\\''`)}'`;
  return `${word} ${socket.includes('/') ? '-S' : '-L'} ${socket}`;
}

/**
 * Run one tmux command against the test socket and return its stdout
 * (trimmed unless `trim: false`, for a capture whose blank leading rows count).
 *
 * The ONLY sanctioned way for a `*.test.js` file to shell out to tmux —
 * ESLint bans direct `execSync`/`child_process` there so ad-hoc calls can't
 * bypass the user-path rule or the socket isolation. Reserve it for
 * environment setup (e.g. creating a sibling session the UI can't create)
 * and ground-truth reads that are explicitly safe per docs/TMUX.md.
 */
function tmuxExec(args, { timeout = 10000, trim = true } = {}) {
  const { execSync } = require('child_process');
  const out = execSync(`${tmuxCmd()} ${args}`, { encoding: 'utf-8', timeout, env: tmuxEnv() });
  return trim ? out.trim() : out;
}

module.exports = {
  tmuxSocket,
  tmuxCmd,
  tmuxEnv,
  scrubbedEnv,
  tmuxExec,
  stateDir,
};
