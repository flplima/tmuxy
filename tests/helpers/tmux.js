/**
 * Tmux Helpers
 *
 * Tmux session management and command execution
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WORKSPACE_ROOT } = require('./config');

/**
 * Run a tmux command and return output
 */
function runTmuxCommand(command) {
  try {
    return execSync(`tmux ${command}`, { encoding: 'utf-8' }).trim();
  } catch (error) {
    console.error(`Failed to run tmux command: ${command}`, error.message);
    throw error;
  }
}

/**
 * Generate a unique test session name
 */
function generateTestSessionName() {
  return `tmuxy_test_${Date.now()}`;
}

/**
 * Create a tmux session for testing
 */
function createTmuxSession(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    // Session already exists
  } catch {
    execSync(`tmux new-session -d -s ${sessionName} -x 120 -y 30`, { stdio: 'inherit' });
  }
}

/**
 * Kill a tmux session
 */
function killTmuxSession(sessionName) {
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
  } catch {
    // Session might not exist
  }
}

/**
 * Capture tmux session text using the Rust binary
 */
function captureTmuxSnapshot(sessionName) {
  const captureScript = path.join(WORKSPACE_ROOT, 'target/release/tmux-capture');
  const captureScriptDebug = path.join(WORKSPACE_ROOT, 'target/debug/tmux-capture');

  let binaryPath = captureScript;
  if (!fs.existsSync(binaryPath)) {
    binaryPath = captureScriptDebug;
    if (!fs.existsSync(binaryPath)) {
      throw new Error('tmux-capture binary not found. Run: cargo build -p tmuxy-core --bin tmux-capture');
    }
  }

  const result = execSync(`${binaryPath} ${sessionName} 200`, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
  }).trim();

  if (fs.existsSync(result)) {
    return fs.readFileSync(result, 'utf-8');
  }
  throw new Error(`Snapshot file not found: ${result}`);
}

module.exports = {
  runTmuxCommand,
  generateTestSessionName,
  createTmuxSession,
  killTmuxSession,
  captureTmuxSnapshot,
};
