const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_PATH = path.resolve(__dirname, '../../../scripts/tmuxy-cli');
const MOCKS_DIR = path.resolve(__dirname, '../mocks');

/**
 * Run the tmuxy CLI with the given arguments and return results.
 *
 * @param {string[]} args - CLI arguments
 * @param {object} [opts] - Options
 * @param {Record<string, string>} [opts.env] - Extra environment variables
 * @returns {{ stdout: string, stderr: string, exitCode: number, tmuxCalls: Array<{args: string[]}> }}
 */
function runCLI(args, opts = {}) {
  const logFile = path.join(os.tmpdir(), `mock-tmux-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const env = {
    ...process.env,
    PATH: `${MOCKS_DIR}:${process.env.PATH}`,
    MOCK_TMUX_LOG: logFile,
    ...opts.env,
  };

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = execFileSync(CLI_PATH, args, {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    stdout = result;
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = err.status ?? 1;
  }

  // If we got stdout but no stderr from a successful run, capture stderr too
  // (execFileSync only throws on non-zero exit, stderr on success needs separate handling)
  // Actually execFileSync with stdio: pipe returns stdout on success, stderr is lost.
  // We need to use execSync or spawnSync instead for stderr capture on success.
  // Let's use spawnSync.

  let tmuxCalls = [];
  try {
    const logContent = fs.readFileSync(logFile, 'utf8').trim();
    if (logContent) {
      tmuxCalls = logContent.split('\n').map(line => JSON.parse(line));
    }
  } catch {
    // No log file or empty — no tmux calls made
  }

  // Clean up log file
  try { fs.unlinkSync(logFile); } catch { /* ignore */ }

  return { stdout, stderr, exitCode, tmuxCalls };
}

/**
 * Run the tmuxy CLI using spawnSync for full stdio capture.
 *
 * @param {string[]} args - CLI arguments
 * @param {object} [opts] - Options
 * @param {Record<string, string>} [opts.env] - Extra environment variables
 * @param {string} [opts.input] - Stdin input
 * @returns {{ stdout: string, stderr: string, exitCode: number, tmuxCalls: Array<{args: string[]}> }}
 */
function runCLIFull(args, opts = {}) {
  const { spawnSync } = require('child_process');
  const logFile = path.join(os.tmpdir(), `mock-tmux-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const env = {
    ...process.env,
    PATH: `${MOCKS_DIR}:${process.env.PATH}`,
    MOCK_TMUX_LOG: logFile,
    ...opts.env,
  };

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
      tmuxCalls = logContent.split('\n').map(line => JSON.parse(line));
    }
  } catch {
    // No log file or empty — no tmux calls made
  }

  // Clean up log file
  try { fs.unlinkSync(logFile); } catch { /* ignore */ }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
    tmuxCalls,
  };
}

module.exports = { runCLI: runCLIFull };
