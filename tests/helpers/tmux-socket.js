/**
 * Shared tmux socket resolution for tests.
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
 * Deliberately NOT `tmuxy`, the socket a running tmuxy serves and `bin/dev`
 * defaults to: this suite creates and kills sessions, panes and windows by the
 * hundred, and a tmux tool is normally developed from inside the very session
 * it would be tearing down. A socket of its own means a suite run cannot touch
 * the session the developer is sitting in.
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
 * Environment for any tmux or tmuxy-CLI child process.
 *
 * `bin/tmuxy-cli` derives its socket from `$TMUX` whenever `TMUX_SOCKET` is
 * unset, so an inherited `$TMUX` aims every mutating command at whatever server
 * the developer's shell is attached to — while the direct `tmux -L` calls above
 * still read from the test socket. Reads and writes then address two different
 * servers and commands fail against panes that only exist in the other.
 *
 * Pinning has to happen here rather than by mutating `process.env` in
 * jest.setup.js: Jest gives each test context a copy of the environment, so
 * those mutations do not reliably reach `child_process`.
 */
function tmuxEnv() {
  const env = { ...process.env, TMUX_SOCKET: tmuxSocket() };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/** `tmux -L <name>` / `tmux -S <path>` prefix for building shell commands. */
function tmuxCmd() {
  const socket = tmuxSocket();
  return `tmux ${socket.includes('/') ? '-S' : '-L'} ${socket}`;
}

/**
 * Run one tmux command against the test socket and return trimmed stdout.
 *
 * The ONLY sanctioned way for a `*.test.js` file to shell out to tmux —
 * ESLint bans direct `execSync`/`child_process` there so ad-hoc calls can't
 * bypass the user-path rule or the socket isolation. Reserve it for
 * environment setup (e.g. creating a sibling session the UI can't create)
 * and ground-truth reads that are explicitly safe per docs/TMUX.md.
 */
function tmuxExec(args, { timeout = 10000 } = {}) {
  const { execSync } = require('child_process');
  return execSync(`${tmuxCmd()} ${args}`, { encoding: 'utf-8', timeout, env: tmuxEnv() }).trim();
}

module.exports = { DEFAULT_SOCKET, tmuxSocket, tmuxCmd, tmuxEnv, tmuxExec };
