/**
 * CLI Helpers
 *
 * Mutating tmux commands for E2E tests, through the tmuxy CLI. Read-only
 * queries go through tmuxExec in tmux-socket.js.
 */

const { execSync } = require('child_process');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TMUXY_CLI = path.join(WORKSPACE_ROOT, 'bin/tmuxy-cli');

const { tmuxEnv } = require('./tmux-socket');

/**
 * Run a tmux command safely through the tmuxy CLI (`tmuxy run <command>`).
 * The command runs inside the server via `tmux run-shell`: the same command
 * sent from an external client while control mode is attached crashes tmux
 * 3.5a. Use for every mutating command (send-keys, split-window, kill-session…).
 *
 * @param {string} command - Full tmux command (e.g. 'send-keys -t mysession -l "echo hi"')
 * @returns {string} Trimmed stdout
 */
function tmuxRun(command) {
  try {
    return execSync(`${TMUXY_CLI} run ${command}`, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: tmuxEnv(),
    }).trim();
  } catch (error) {
    // execSync's message is just "Command failed: <cmd>" — the reason tmux gave
    // is in stderr, which is the only part that says what actually went wrong.
    const stderr = (error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    throw new Error(
      `tmuxy run ${command} failed (exit ${error.status})` +
        (stderr ? `\n  stderr: ${stderr}` : '') +
        (stdout ? `\n  stdout: ${stdout}` : ''),
    );
  }
}

module.exports = {
  tmuxRun,
  TMUXY_CLI,
};
