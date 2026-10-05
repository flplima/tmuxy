const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_PATH = path.resolve(__dirname, '../../../bin/tmuxy-cli');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');

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
  const socket = extraEnv.TMUX_SOCKET || process.env.TMUX_SOCKET || 'tmuxy';
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
 * it should act on (bin/tmuxy-cli, TMUX_PANE); the tests assert on the
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
 * Build the environment the CLI runs under: the mock tmux on PATH, a log file
 * for the recorded calls, and any per-test overrides.
 *
 * The CLI derives its socket from $TMUX when TMUX_SOCKET is unset. Inheriting
 * it would point every assertion at whatever tmux server the developer's shell
 * is attached to — and this being a tmux tool, running the suite from inside a
 * pane is the normal case, not the exception. Drop it unless a test pinned a
 * socket of its own.
 *
 * @param {string} logFile - Path the mock tmux appends its calls to
 * @param {object} opts - Same opts object runCLI/runCLIFull received
 * @returns {Record<string, string>} Environment for the child process
 */
function buildEnv(logFile, opts = {}) {
  const env = {
    ...process.env,
    PATH: `${MOCKS_DIR}:${process.env.PATH}`,
    MOCK_TMUX_LOG: logFile,
    ...opts.env,
  };
  if (!opts.env?.TMUX_SOCKET) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  return env;
}

/**
 * Run the tmuxy CLI using spawnSync for full stdio capture.
 *
 * @param {string[]} args - CLI arguments
 * @param {object} [opts] - Options
 * @param {Record<string, string>} [opts.env] - Extra environment variables
 * @param {string} [opts.input] - Stdin input
 * @returns {{ stdout: string, stderr: string, exitCode: number, tmuxCalls: Array<{args: string[]}>, paneResolution: {args: string[]} | null }}
 */
function runCLIFull(args, opts = {}) {
  const logFile = path.join(
    os.tmpdir(),
    `mock-tmux-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const env = buildEnv(logFile, opts);

  const result = spawnSync(CLI_PATH, args, {
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
    input: opts.input,
  });

  let tmuxCalls = [];
  try {
    const logContent = fs.readFileSync(logFile, 'utf8').trim();
    if (logContent) {
      tmuxCalls = logContent.split('\n').map((line) => JSON.parse(line));
    }
  } catch {
    // No log file or empty — no tmux calls made
  }
  const allCalls = stripSocketArgs(tmuxCalls, opts.env);
  tmuxCalls = withoutPaneResolution(allCalls);
  const paneResolution = allCalls.find(isPaneResolution) ?? null;

  // Clean up log file
  try {
    fs.unlinkSync(logFile);
  } catch {
    /* ignore */
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
    tmuxCalls,
    paneResolution,
  };
}

/**
 * Run several CLI invocations at once and wait for all of them.
 *
 * Exists for the inter-agent queue's lock: serialized runs prove nothing about a
 * mutex, so the concurrency test has to have the processes genuinely overlap.
 * tmux calls are not collected — the contention, not the argv, is the point.
 *
 * @param {string[][]} argvList - One argument array per invocation
 * @param {object} [opts] - Options
 * @param {Record<string, string>} [opts.env] - Extra environment variables
 * @returns {Promise<number[]>} Exit code of each invocation, in order
 */
function runCLIConcurrent(argvList, opts = {}) {
  const logFile = path.join(
    os.tmpdir(),
    `mock-tmux-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = buildEnv(logFile, opts);

  return Promise.all(
    argvList.map(
      (args) =>
        new Promise((resolve) => {
          const child = spawn(CLI_PATH, args, { env, stdio: 'ignore' });
          child.on('close', (code) => resolve(code ?? 1));
        }),
    ),
  ).finally(() => {
    try {
      fs.unlinkSync(logFile);
    } catch {
      /* ignore */
    }
  });
}

/**
 * A pid that certainly existed and has certainly exited.
 *
 * For the stale-lock test: reusing a plausible-looking number risks naming a
 * live process, which is the opposite of what that test needs to set up.
 *
 * @returns {number} The pid of a process that has already been reaped
 */
function reapedPid() {
  return spawnSync('sh', ['-c', 'exit 0']).pid;
}

module.exports = { runCLI: runCLIFull, runCLIConcurrent, reapedPid };
