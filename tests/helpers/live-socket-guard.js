/**
 * The sockets no test suite may use: they belong to a tmux someone is working
 * in. A suite creates and kills panes, windows and whole servers, and it is
 * normally started from a shell inside the very session it would be killing.
 */

const fs = require('fs');
const path = require('path');

/** A released build's socket, the dev server's, and plain tmux's. */
const LIVE_SOCKET_NAMES = ['tmuxy', 'tmuxy-dev', 'default'];

/** The socket path in a `$TMUX` value (`<path>,<server pid>,<session>`). */
function socketOfTmuxEnv(value) {
  return value ? value.split(',')[0] : '';
}

/** Whether `file` is a socket on disk: something may be listening on it. */
function isSocketFile(file) {
  try {
    return fs.statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** The directory tmux keeps this user's sockets in, when nothing moves it. */
function liveSocketDirectory() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`);
}

function isInLiveDirectory(socketPath) {
  const real = (dir) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  return real(path.dirname(socketPath)) === real(liveSocketDirectory());
}

/**
 * Why a suite may not use `socket` (a name for `tmux -L`, or a path for
 * `tmux -S`), or `null` when it may.
 *
 * @param {object} asked
 * @param {string} asked.socket - The socket the suite is about to use
 * @param {string} [asked.shellTmux] - `$TMUX` of the shell that started the suite
 * @param {string[]} [asked.reserved] - More names that are someone else's
 * @param {(socket: string) => boolean} [asked.answers] - Whether a server the
 *   suite did not start already answers on the socket
 * @returns {string | null}
 */
function liveSocketProblem({
  socket,
  shellTmux = process.env.TMUX,
  reserved = [],
  answers = () => false,
}) {
  if (!socket) {
    return 'no socket is named, so tmux and the CLI would fall back to $TMUX or to the default socket';
  }
  // By name, or by the path that name has in the directory tmux keeps its
  // sockets in (`tmux -S /tmp/tmux-<uid>/tmuxy` is `tmux -L tmuxy`).
  const named = socket.includes('/') && isInLiveDirectory(socket) ? path.basename(socket) : socket;
  if ([...LIVE_SOCKET_NAMES, ...reserved].includes(named)) {
    return `"${socket}" is a socket people work in (a released tmuxy, the dev server, plain tmux, another suite), never a suite's own`;
  }
  const shell = socketOfTmuxEnv(shellTmux);
  const sameAsShell =
    shell && (socket === shell || (!socket.includes('/') && socket === path.basename(shell)));
  if (sameAsShell) {
    return `"${socket}" is the socket of the tmux this shell runs in`;
  }
  if (answers(socket)) {
    return `a tmux server this run did not start already answers on "${socket}"`;
  }
  return null;
}

module.exports = {
  isSocketFile,
  liveSocketDirectory,
  liveSocketProblem,
  socketOfTmuxEnv,
};
