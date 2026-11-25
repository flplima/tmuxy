/**
 * Once after the run, passed or failed: stops what the run started
 * (helpers/run-ownership.js). A server the run reused, and its tmux server,
 * are left running.
 */
module.exports = async function globalTeardown() {
  globalThis.tmuxyE2ERun?.release();
};
