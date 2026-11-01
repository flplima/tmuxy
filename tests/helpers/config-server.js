/**
 * A tmuxy server with a config directory of its own.
 *
 * A test of what a user can put in their config dir — a theme, `custom.css`, a
 * `tmuxy.conf` edit — needs a directory it may write to and a server that
 * reads that one, so it gets both on a port of their own, with a data and a
 * state dir of its own beside them: the built-ins it mirrors, the chain it
 * builds and the reload marker `tmuxy config reload` touches are its alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { TMUXY_PORT } = require('./config');
const { startExtraServer } = require('./extra-server');
const { TMUXY_CLI, tmuxRunAsOperator } = require('./cli');

// Clear of the suite's port.
const CONFIG_PORT = parseInt(process.env.TMUXY_CONFIG_PORT || String(TMUXY_PORT + 200), 10);
const CONFIG_URL = `http://localhost:${CONFIG_PORT}`;

/**
 * The scratch root: `$XDG_CONFIG_HOME`, the data dir, the state dir and a
 * `$HOME` (whose `.tmux.conf` is the one `use-tmux-conf` reads) under it.
 */
const ROOT = path.join(os.tmpdir(), `tmuxy-e2e-config-${CONFIG_PORT}`);
const CONFIG_HOME = path.join(ROOT, 'config');
const CONFIG_DIR = path.join(CONFIG_HOME, 'tmuxy');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, 'state');
const HOME_DIR = path.join(ROOT, 'home');
const DIRS = {
  XDG_CONFIG_HOME: CONFIG_HOME,
  TMUXY_DATA_DIR: DATA_DIR,
  TMUXY_STATE_DIR: STATE_DIR,
  HOME: HOME_DIR,
};

/**
 * Start the server with no config dir at all, a first run; resolves to a
 * function that stops it. By the time it answers, `CONFIG_DIR` holds the
 * starter `tmuxy.conf`, `DATA_DIR` the built-in themes and `STATE_DIR` the
 * chain.
 */
async function startConfigServer() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  return startExtraServer(CONFIG_PORT, [], DIRS);
}

/** The tmuxy CLI against the scratch dirs; returns what it printed. */
const configCli = (...args) =>
  execFileSync(TMUXY_CLI, ['config', ...args], {
    env: { ...process.env, ...DIRS },
    encoding: 'utf8',
  });

/** `tmuxy config reload` against the scratch dirs; returns what it printed. */
const reloadConfig = () => configCli('reload');

/** `tmuxy config use-tmux-conf <value>` against the scratch dirs. */
const useTmuxConf = (value) => configCli('use-tmux-conf', value);

/**
 * Unset the options the suite sets from its config: a `@tmuxy-css-*` one and
 * the theme it pins. They are GLOBAL tmux options, and the suite's tmux server
 * outlives a run: left set, they would win over the next run's theme before
 * that run has set anything. An option is the user's to set (`tmuxy run` sets
 * none), so as the operator.
 */
const unsetConfigVariable = () => {
  tmuxRunAsOperator('set-option -gu @tmuxy-css-term-background');
  tmuxRunAsOperator('set-option -gu @tmuxy-theme');
  tmuxRunAsOperator('set-option -gu @tmuxy-e2e-tmux-conf');
};

module.exports = {
  CONFIG_URL,
  CONFIG_HOME,
  CONFIG_DIR,
  DATA_DIR,
  STATE_DIR,
  HOME_DIR,
  startConfigServer,
  reloadConfig,
  useTmuxConf,
  unsetConfigVariable,
};
