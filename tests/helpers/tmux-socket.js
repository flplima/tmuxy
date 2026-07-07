/**
 * Shared tmux socket resolution for tests.
 *
 * The tmuxy server always talks to a NAMED tmux socket: `TMUX_SOCKET` when
 * set, otherwise the dedicated `tmuxy` socket (see tmuxy-core `tmux_socket()`).
 * Every test helper that shells out to tmux must target the same socket, or
 * it silently operates on the default server: sessions "don't exist",
 * kill-session cleans nothing (leaking panes across tests), and list queries
 * return the wrong world.
 */

/** The socket name the tmuxy server under test uses. */
function tmuxSocket() {
  return process.env.TMUX_SOCKET || 'tmuxy';
}

/** `tmux -L <socket>` prefix for building shell commands. */
function tmuxCmd() {
  return `tmux -L ${tmuxSocket()}`;
}

module.exports = { tmuxSocket, tmuxCmd };
