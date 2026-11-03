/**
 * Plugins for the E2E suites: a fixture plugin written to a scratch dir,
 * `tmuxy plugin …` against the suite's own dirs and socket, and what the
 * page and the plugin's state dir say about it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmuxyCli } = require('./cli');
const { stateDir } = require('./tmux-socket');

/** A plugin dir with `manifest` and executable `bin/<name>` scripts; returns it. */
function writePluginDir(manifest, scripts = {}, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-e2e-plugin-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'tmuxy-plugin.toml'), manifest);
  for (const [name, text] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(dir, 'bin', name), text, { mode: 0o755 });
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** `tmuxy plugin …` against the suite's own dirs and socket. */
const pluginCli = (...args) => tmuxyCli(['plugin', ...args]);

/** A plugin's state dir: its log and what its commands leave there. */
const pluginStateDir = (name) => path.join(stateDir(), 'plugins', `${name}.state`);

/** The menu actions the page knows of, as `plugin:action`. */
const knownActions = (page) =>
  page.evaluate(() =>
    window.app
      .getSnapshot()
      .context.plugins.flatMap((p) => p.actions.map((a) => `${p.name}:${a.id}`)),
  );

module.exports = { writePluginDir, pluginCli, pluginStateDir, knownActions };
