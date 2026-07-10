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

module.exports = { tmuxSocket, tmuxCmd };
