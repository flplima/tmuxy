/**
 * A tmuxy server with a config directory of its own.
 *
 * The suite's server reads the developer's `~/.config/tmuxy`. A test of what a
 * user can put there — a theme, `custom.css`, a `tmuxy.conf` edit — needs a
 * directory it may write to and a server that reads that one, so it gets both
 * on a port of their own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { TMUXY_PORT } = require('./config');
const { startExtraServer } = require('./extra-server');
const { TMUXY_CLI, tmuxRun } = require('./cli');

// Clear of the suite's port.
const CONFIG_PORT = parseInt(process.env.TMUXY_CONFIG_PORT || String(TMUXY_PORT + 200), 10);
const CONFIG_URL = `http://localhost:${CONFIG_PORT}`;

/** The scratch `$XDG_CONFIG_HOME`; the server's files land in `tmuxy/` under it. */
const CONFIG_HOME = path.join(os.tmpdir(), `tmuxy-e2e-config-${CONFIG_PORT}`);
const CONFIG_DIR = path.join(CONFIG_HOME, 'tmuxy');

/**
 * Start the server on an empty config dir; resolves to a function that stops
 * it. The server materializes the dir at launch, so by the time it answers,
 * `CONFIG_DIR` holds the built-in themes and a fresh `tmuxy.conf`.
 */
async function startConfigServer() {
  fs.rmSync(CONFIG_HOME, { recursive: true, force: true });
  fs.mkdirSync(CONFIG_HOME, { recursive: true });
  return startExtraServer(CONFIG_PORT, [], { XDG_CONFIG_HOME: CONFIG_HOME });
}

/** `tmuxy config reload` against the scratch config dir; returns what it printed. */
function reloadConfig() {
  return execFileSync(TMUXY_CLI, ['config', 'reload'], {
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME },
    encoding: 'utf8',
  });
}

/**
 * Unset the one `@tmuxy-css-*` option the suite sets from its config. It is a
 * GLOBAL tmux option, and the suite's tmux server outlives a run: left set,
 * it would win over the next run's theme before that run has set anything.
 */
const unsetConfigVariable = () => tmuxRun('set-option -gu @tmuxy-css-term-background');

module.exports = {
  CONFIG_URL,
  CONFIG_HOME,
  CONFIG_DIR,
  startConfigServer,
  reloadConfig,
  unsetConfigVariable,
};
