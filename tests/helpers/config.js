/**
 * The E2E suite's ports, paths, binaries and wait scale.
 */

const fs = require('fs');
const path = require('path');

// The dev environment's Chrome answers on 9222 and the suites attach to it.
// Pointing TMUXY_CDP_PORT at a closed port is how you make a run launch its
// own headless browser instead — the shape CI runs in.
const CDP_PORT = Number(process.env.TMUXY_CDP_PORT || 9222);
/**
 * The port the E2E suite owns, when `TMUXY_PORT` says nothing else.
 *
 * One port per environment, for the same reason there is one socket per
 * environment (see DEFAULT_SOCKET in helpers/tmux-socket.js): the server is the
 * other half of every round trip, so a run that finds a STRANGER's server on
 * its port is driving a server attached to a different tmux socket. That fails
 * as a wall of unrelated flakes — sessions that "don't exist", waits that time
 * out, a different test failing each run — rather than as a port conflict.
 *
 * 9000 belongs to a released build and `bin/dev-server`; this suite takes 9100, which
 * a dev server or a second agent cannot collide with by accident.
 */
const DEFAULT_PORT = 9100;
const TMUXY_PORT = parseInt(process.env.TMUXY_PORT || String(DEFAULT_PORT), 10);
const TMUXY_URL = `http://localhost:${TMUXY_PORT}`;

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TMUXY_CLI = path.join(WORKSPACE_ROOT, 'packages/tmuxy-cli/bin/tmuxy-cli');

/**
 * The server every E2E server runs: the release build `jest.setup.js` builds
 * (and CI builds). One build, so a run never mixes the suite's server with an
 * older or a debug one beside it.
 */
function serverBinary() {
  const file = path.join(WORKSPACE_ROOT, 'target/release/tmuxy-server');
  if (!fs.existsSync(file)) throw new Error(`no release tmuxy-server at ${file}`);
  return file;
}

/** The desktop app the Tauri and smoke suites drive: `$TAURI_BINARY`, else the debug build. */
function tauriBinary() {
  return process.env.TAURI_BINARY || path.join(WORKSPACE_ROOT, 'target/debug/tmuxy');
}

const DELAYS = {
  SHORT: 100,
  MEDIUM: 200,
  LONG: 500,
  SYNC: 1500, // For UI/tmux sync (full round trip: browser→HTTP→server→control mode→tmux→SSE→browser)
};

/**
 * How much longer this machine needs than the one a wait's budget was written
 * on (`TMUXY_WAIT_SCALE`, default 1). Every wait budget is a number measured on
 * someone's laptop; this restates all of them at once for a slower or busier
 * machine. Raising it cannot turn a failing test green — a condition that
 * never holds still never holds — it only buys a slow machine time.
 */
const WAIT_SCALE = Math.max(0.1, parseFloat(process.env.TMUXY_WAIT_SCALE || '1') || 1);

/** A wait budget in ms, restated for this machine. */
const waitBudget = (ms) => Math.round(ms * WAIT_SCALE);

module.exports = {
  WAIT_SCALE,
  waitBudget,
  CDP_PORT,
  TMUXY_PORT,
  TMUXY_URL,
  WORKSPACE_ROOT,
  TMUXY_CLI,
  serverBinary,
  tauriBinary,
  DELAYS,
};
