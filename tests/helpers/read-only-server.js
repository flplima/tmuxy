/**
 * A second, `--read-only` tmuxy server beside the suite's own.
 *
 * Read-only is a property of the server process, so a viewer needs its own
 * server on its own port, attached to the same tmux socket as the one the
 * suite writes through.
 */

const { TMUXY_PORT } = require('./config');
const { startExtraServer } = require('./extra-server');

// Well clear of the suite's port: a `--dev` server also takes the two after its own.
const READ_ONLY_PORT = parseInt(process.env.TMUXY_READ_ONLY_PORT || String(TMUXY_PORT + 100), 10);
const READ_ONLY_URL = `http://localhost:${READ_ONLY_PORT}`;

/**
 * Start the read-only server for one session; resolves to a function that
 * stops it.
 *
 * `session` is required because a read-only server is pinned to it: it serves
 * that name and 404s every other, which is what keeps a viewer beside a writer
 * on the same socket from naming its way into the writer's other sessions.
 */
const startReadOnlyServer = (session) => {
  if (!session) throw new Error('startReadOnlyServer needs the session to pin to');
  return startExtraServer(READ_ONLY_PORT, ['--read-only', '--session', session]);
};

module.exports = { READ_ONLY_URL, startReadOnlyServer };
