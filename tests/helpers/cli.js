/**
 * CLI Helpers
 *
 * Wrappers around the tmuxy CLI and direct tmux commands for E2E tests.
 * Replaces the previous approach of routing commands through window._adapter.
 */

const { execSync } = require('child_process');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TMUXY_CLI = path.join(WORKSPACE_ROOT, 'scripts/tmuxy-cli');

/**
 * Run a tmux command safely through the tmuxy CLI (`tmuxy run <command>`).
 * Routes through `tmux run-shell` to avoid crashing tmux 3.5a control mode.
 * Use for all mutating commands (send-keys, split-window, kill-session, etc.).
 *
 * @param {string} command - Full tmux command (e.g. 'send-keys -t mysession -l "echo hi"')
 * @returns {string} Trimmed stdout
 */
function tmuxRun(command) {
  return execSync(`${TMUXY_CLI} run ${command}`, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

/**
 * Run a read-only tmux command directly via `tmux <command>`.
 * Safe for read-only queries (list-panes, list-windows, capture-pane, has-session, display-message)
 * even while control mode is attached.
 *
 * @param {string} command - Full tmux command (e.g. 'list-panes -t mysession -F "#{pane_id}"')
 * @returns {string} Trimmed stdout
 */
function tmuxQuery(command) {
  return execSync(`tmux ${command}`, {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

module.exports = {
  tmuxRun,
  tmuxQuery,
  TMUXY_CLI,
};
