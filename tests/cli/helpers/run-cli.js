const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scriptEnv, withScratchDir } = require('./env');

const CLI_PATH = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy-cli');

/**
 * Every tmux invocation the CLI makes MUST target the dedicated socket
 * (`-L <name>`, or `-S <path>` when TMUX_SOCKET holds a path) — never the
 * user's default tmux server. Assert that invariant on every recorded call,
 * then strip the flag pair so tests assert on the actual subcommand argv.
 *
 * @param {Array<{args: string[]}>} tmuxCalls - Raw recorded calls
 * @param {Record<string, string>} [extraEnv] - Env the CLI ran with
 * @returns {Array<{args: string[]}>} Calls with the socket pair stripped
 */
function stripSocketArgs(tmuxCalls, extraEnv = {}) {
  const socket = extraEnv.TMUX_SOCKET || 'tmuxy';
  const expectedFlag = socket.includes('/') ? '-S' : '-L';
  return tmuxCalls.map((call) => {
    const [flag, value, ...rest] = call.args;
    if (flag !== expectedFlag || value !== socket) {
      throw new Error(
        `tmux invoked without the dedicated socket: expected leading ` +
          `"${expectedFlag} ${socket}", got argv ${JSON.stringify(call.args)}`,
      );
    }
    return { ...call, args: rest };
  });
}

/**
 * Drop the CLI's pane resolution. From outside a pane the CLI opens every
 * invocation with one read-only `list-panes -a -f …` asking tmux which pane
 * it should act on (packages/tmuxy-cli/bin/tmuxy-cli, TMUX_PANE); the tests assert on the
 * command that follows it. `cli-pane.test.js` covers the resolver itself.
 *
 * @param {Array<{args: string[]}>} tmuxCalls - Calls with the socket pair stripped
 * @returns {Array<{args: string[]}>} The same calls without the resolver
 */
function isPaneResolution(call) {
  return call.args[0] === 'list-panes' && call.args[1] === '-a' && call.args[2] === '-f';
}

function withoutPaneResolution(tmuxCalls) {
  const [first, ...rest] = tmuxCalls;
  return first && isPaneResolution(first) ? rest : tmuxCalls;
}

/**
 * `_run_shell` (packages/tmuxy-cli/bin/tmuxy/_lib) wraps every run-shell command in the group and
 * redirects that bring its output and exit status back through files. The
 * wrapping is the same on every call and carries a temp path, so it is
 * stripped once here; the tests assert on the command itself.
 */
const RUN_SHELL_WRAP = /^\{ (.*) ; \} >'[^']*\/out' 2>'[^']*\/err'; echo \$\? >'[^']*\/status'$/s;

function withoutRunShellWrap(tmuxCalls) {
  return tmuxCalls.map((call) => {
    if (call.args[0] !== 'run-shell') return call;
    // The caller's pane, when the CLI knew one, is run-shell's `-t` target;
    // it is lifted out so the command stays at args[1] and tests can assert
    // on it as `target`.
    const targeted = call.args[1] === '-t';
    const rest = call.args.slice(targeted ? 3 : 1);
    const match = RUN_SHELL_WRAP.exec(rest[0] ?? '');
    return {
      ...call,
      ...(targeted && { target: call.args[2] }),
      args: ['run-shell', match ? match[1] : rest[0], ...rest.slice(1)],
    };
  });
}

/**
 * Run the tmuxy CLI using spawnSync for full stdio capture.
 *
 * @param {string[]} args - CLI arguments
 * @param {object} [opts] - Options
 * @param {Record<string, string>} [opts.env] - Extra environment variables
 * @param {string} [opts.input] - Stdin input
 * @param {string} [opts.cli] - The dispatcher to run, when not the repo's
 * @param {string} [opts.path] - PATH in place of the mocks' directory and the inherited one
 * @returns {{ stdout: string, stderr: string, exitCode: number, tmuxCalls: Array<{args: string[]}>, paneResolution: {args: string[]} | null }}
 */
function runCLIFull(args, opts = {}) {
  return withScratchDir('tmuxy-cli-', (home) => {
    const logFile = path.join(home, 'mock-tmux.log');
    const env = scriptEnv(home, {
      MOCK_TMUX_LOG: logFile,
      ...(opts.path && { PATH: opts.path }),
      ...opts.env,
    });
    const result = spawnSync(opts.cli ?? CLI_PATH, args, {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      input: opts.input,
    });
    // A CLI that hangs (killed at the timeout) or never started is no exit
    // status at all: reported as one, it would pass every "exits 1" test.
    if (result.error || result.status === null) {
      throw new Error(
        `tmuxy ${args.join(' ')} did not exit: ${result.error?.message ?? `killed by ${result.signal}`}` +
          `\nstderr: ${result.stderr || ''}`,
      );
    }

    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim() : '';
    const recorded = log ? log.split('\n').map((line) => JSON.parse(line)) : [];
    const allCalls = stripSocketArgs(recorded, opts.env);
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status,
      tmuxCalls: withoutRunShellWrap(withoutPaneResolution(allCalls)),
      rawRunShells: allCalls.filter((call) => call.args[0] === 'run-shell'),
      paneResolution: allCalls.find(isPaneResolution) ?? null,
    };
  });
}

module.exports = { runCLI: runCLIFull };
