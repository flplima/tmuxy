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

/** The socket name or path the tmuxy server under test uses. */
function tmuxSocket() {
  return process.env.TMUX_SOCKET || 'tmuxy';
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
  return execSync(`${tmuxCmd()} ${args}`, { encoding: 'utf-8', timeout }).trim();
}

module.exports = { tmuxSocket, tmuxCmd, tmuxExec };
