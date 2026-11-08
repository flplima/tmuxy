/**
 * Mutating tmux commands for the E2E tests, through the tmuxy CLI. Read-only
 * queries go through tmuxExec in tmux-socket.js.
 */

const { execFileSync, execSync } = require('child_process');
const path = require('path');

const { WORKSPACE_ROOT, TMUXY_CLI, serverBinary } = require('./config');
const { tmuxEnv } = require('./tmux-socket');

/**
 * The environment for a CLI call: the suite's own socket and dirs, and the
 * server binary under test named outright. Left to find one, the CLI takes
 * `tmuxy-server` from PATH, then `target/debug`, then `target/release`, so a
 * stale debug build beside the release one the suite runs answered every
 * `tmuxy run` with an older build's verbs.
 */
const cliEnv = () => ({ ...tmuxEnv(), TMUXY_SERVER_BIN: serverBinary() });

/**
 * Run a tmux command safely through the tmuxy CLI (`tmuxy run <command>`).
 * The command runs inside the server via `tmux run-shell`: the same command
 * sent from an external client while control mode is attached crashes tmux
 * 3.5a. Use for the mutations `tmuxy run` passes on (select-pane,
 * move-window, kill-session…); `tmuxRunAsOperator` for the rest.
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
      env: cliEnv(),
    }).trim();
  } catch (error) {
    // execSync's message is only "Command failed: <cmd>"; tmux's reason is in stderr.
    const stderr = (error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    throw new Error(
      `tmuxy run ${command} failed (exit ${error.status})` +
        (stderr ? `\n  stderr: ${stderr}` : '') +
        (stdout ? `\n  stdout: ${stdout}` : ''),
    );
  }
}

const CLI_LIB = path.join(WORKSPACE_ROOT, 'packages/tmuxy-cli/bin/tmuxy/_lib');

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A tmux command as the person running the suite would run it: through
 * run-shell, like `tmuxRun`, but not through `tmuxy run`, which refuses what
 * would get around the send question — keys into a pane, a shell, a config
 * file, any option. Those are the harness setting up
 * what a user puts in their tmux.conf or types themselves, not a test of the
 * CLI. `#` is doubled as `tmuxy run` doubles it, so run-shell expands nothing.
 *
 * @param {string} command - Full tmux command, shell-quoted as for `tmuxRun`
 * @param {Record<string, string>} [env] - The socket's environment
 * @returns {string} Trimmed stdout
 */
function tmuxRunAsOperator(command, env = tmuxEnv()) {
  return execSync(
    `bash -c 'source "$0"; _run_safe "$1"' ${shellQuote(CLI_LIB)} ${shellQuote(command.replace(/#/g, '##'))}`,
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  ).trim();
}

/**
 * The tmuxy CLI as the person at the terminal runs it, against the suite's
 * own socket and scratch dirs: for verbs a test drives rather than asserts
 * the routing of (`tmuxy plugin install`, say).
 *
 * @param {string[]} args - The CLI's arguments
 * @returns {string} What it printed
 */
function tmuxyCli(args) {
  return execFileSync(TMUXY_CLI, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The build under test, as a pane's shell gets it from the server's
    // published environment: a `tmuxy-server` on PATH is some other build.
    env: cliEnv(),
  });
}

module.exports = {
  tmuxRun,
  tmuxRunAsOperator,
  tmuxyCli,
  TMUXY_CLI,
};
