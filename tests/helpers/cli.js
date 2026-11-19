/**
 * Mutating tmux commands for the E2E tests, through the tmuxy CLI. Read-only
 * queries go through tmuxExec in tmux-socket.js.
 */

const { execFileSync, execSync, spawn } = require('child_process');
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
 * @param {Record<string, string>} [extraEnv] - More environment for it
 * @returns {string} What it printed
 */
function tmuxyCli(args, extraEnv = {}) {
  return execFileSync(TMUXY_CLI, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The build under test, as a pane's shell gets it from the server's
    // published environment: a `tmuxy-server` on PATH is some other build.
    // `extraEnv` adds to it: `TMUX_PANE` runs the CLI as from that pane.
    env: { ...cliEnv(), ...extraEnv },
  });
}

/**
 * {@link tmuxyCli} for a verb that waits (`agent wait`), so the test can act
 * while it does. Resolves to its exit code and output, whatever the code.
 *
 * @param {string[]} args - The CLI's arguments
 * @param {Record<string, string>} [extraEnv] - More environment for it
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function tmuxyCliAsync(args, extraEnv = {}) {
  return tmuxyCliStream(args, extraEnv).exited;
}

/**
 * {@link tmuxyCliAsync} for a verb that prints as it goes (`pane listen`):
 * what it has printed so far can be read while it runs, so a test can wait
 * for a line before it acts.
 *
 * @param {string[]} args - The CLI's arguments
 * @param {Record<string, string>} [extraEnv] - More environment for it
 * @returns {{printed: () => string, exited: Promise<{code: number, stdout: string, stderr: string}>}}
 */
function tmuxyCliStream(args, extraEnv = {}) {
  let stdout = '';
  let stderr = '';
  const child = spawn(TMUXY_CLI, args, {
    cwd: WORKSPACE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { ...cliEnv(), ...extraEnv },
  });
  child.stdout.setEncoding('utf-8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf-8').on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: stderr + error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return { printed: () => stdout, exited };
}

/**
 * An agent's hook event as `tmuxy agent hook` hands it to the binary: the
 * event's JSON on stdin, run as from `pane`. Prints the state it means.
 *
 * @param {string} agent - `claude`, `codex` or `agy`
 * @param {string} event - The hook event (`SessionStart`, …)
 * @param {object} payload - The event's JSON
 * @param {string} pane - The pane the hook runs in
 * @returns {string} What it printed
 */
function agentHookEvent(agent, event, payload, pane) {
  return execFileSync(serverBinary(), ['agent', 'state', agent, event], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...cliEnv(), TMUX_PANE: pane },
  });
}

module.exports = {
  agentHookEvent,
  tmuxRun,
  tmuxRunAsOperator,
  tmuxyCli,
  tmuxyCliAsync,
  tmuxyCliStream,
  TMUXY_CLI,
};
