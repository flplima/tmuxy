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

/** Start the read-only server; resolves to a function that stops it. */
const startReadOnlyServer = () => startExtraServer(READ_ONLY_PORT, ['--read-only']);

module.exports = { READ_ONLY_URL, startReadOnlyServer };
