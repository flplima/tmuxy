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
    console.log(`Session ${sessionName} already exists`);
  } catch {
    execSync(`tmux new-session -d -s ${sessionName} -x 120 -y 30`, { stdio: 'inherit' });
    console.log(`Created tmux session: ${sessionName}`);
  }
}

/**
 * Kill a tmux session
 */
function killTmuxSession(sessionName) {
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
    console.log(`Killed tmux session: ${sessionName}`);
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

/**
 * Get pane count in a session
 */
function getTmuxPaneCount(sessionName) {
  const result = runTmuxCommand(`list-panes -t ${sessionName} -F "#{pane_id}"`);
  return result.split('\n').filter(line => line.trim()).length;
}

/**
 * Get detailed pane info
 */
function getTmuxPaneInfo(sessionName) {
  const result = runTmuxCommand(
    `list-panes -t ${sessionName} -F "#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_top}|#{pane_left}"`
  );
  return result.split('\n').filter(line => line.trim()).map(line => {
    const [id, index, width, height, active, top, left] = line.split('|');
    return {
      id,
      index: parseInt(index, 10),
      width: parseInt(width, 10),
      height: parseInt(height, 10),
      active: active === '1',
      y: parseInt(top, 10),
      x: parseInt(left, 10),
    };
  });
}

/**
 * Get active pane ID
 */
function getActiveTmuxPane(sessionName) {
  return runTmuxCommand(`display-message -t ${sessionName} -p "#{pane_id}"`);
}

/**
 * Get window count
 */
function getTmuxWindowCount(sessionName) {
  const result = runTmuxCommand(`list-windows -t ${sessionName} -F "#{window_index}"`);
  return result.split('\n').filter(line => line.trim()).length;
}

/**
 * Check if current pane is zoomed
 */
function isPaneZoomed(sessionName) {
  try {
    const result = runTmuxCommand(`display-message -t ${sessionName} -p "#{window_zoomed_flag}"`);
    return result.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Send keys directly to tmux (bypassing UI)
 */
function sendKeysToTmux(sessionName, keys) {
  runTmuxCommand(`send-keys -t ${sessionName} ${keys}`);
}

module.exports = {
  runTmuxCommand,
  generateTestSessionName,
  createTmuxSession,
  killTmuxSession,
  captureTmuxSnapshot,
  getTmuxPaneCount,
  getTmuxPaneInfo,
  getActiveTmuxPane,
  getTmuxWindowCount,
  isPaneZoomed,
  sendKeysToTmux,
};
