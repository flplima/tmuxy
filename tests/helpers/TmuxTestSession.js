/**
 * TmuxTestSession - Encapsulates tmux test session lifecycle and state queries
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WORKSPACE_ROOT } = require('./config');

class TmuxTestSession {
  constructor(name = null) {
    this.name = name || `tmuxy_test_${Date.now()}`;
    this.created = false;
  }

  /**
   * Run a tmux command and return output
   */
  runCommand(command) {
    try {
      return execSync(`tmux ${command}`, { encoding: 'utf-8' }).trim();
    } catch (error) {
      console.error(`Failed to run tmux command: ${command}`, error.message);
      throw error;
    }
  }

  /**
   * Run a tmux command targeting this session
   */
  run(command) {
    return this.runCommand(`${command} -t ${this.name}`);
  }

  /**
   * Create the tmux session
   */
  create(options = {}) {
    const { width = 120, height = 30 } = options;

    try {
      execSync(`tmux has-session -t ${this.name} 2>/dev/null`, { stdio: 'ignore' });
      console.log(`Session ${this.name} already exists`);
    } catch {
      execSync(`tmux new-session -d -s ${this.name} -x ${width} -y ${height}`, { stdio: 'inherit' });
      console.log(`Created tmux session: ${this.name}`);
    }

    this.created = true;
    return this;
  }

  /**
   * Destroy the tmux session
   */
  destroy() {
    if (!this.created) return;

    try {
      execSync(`tmux kill-session -t ${this.name}`, { stdio: 'ignore' });
      console.log(`Killed tmux session: ${this.name}`);
    } catch {
      // Session might not exist
    }

    this.created = false;
  }

  /**
   * Check if session exists
   */
  exists() {
    try {
      execSync(`tmux has-session -t ${this.name} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  // ==================== Pane Queries ====================

  /**
   * Get pane count
   */
  getPaneCount() {
    const result = this.runCommand(`list-panes -t ${this.name} -F "#{pane_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get window count
   */
  getWindowCount() {
    const result = this.runCommand(`list-windows -t ${this.name} -F "#{window_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get detailed pane info
   */
  getPaneInfo() {
    const result = this.runCommand(
      `list-panes -t ${this.name} -F "#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_top}|#{pane_left}"`
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
  getActivePaneId() {
    return this.runCommand(`display-message -t ${this.name} -p "#{pane_id}"`);
  }

  /**
   * Check if current pane is zoomed
   */
  isPaneZoomed() {
    try {
      const result = this.runCommand(`display-message -t ${this.name} -p "#{window_zoomed_flag}"`);
      return result.trim() === '1';
    } catch {
      return false;
    }
  }

  /**
   * Check if current pane is in copy mode
   */
  isPaneInCopyMode() {
    try {
      const result = this.runCommand(`display-message -t ${this.name} -p "#{pane_in_mode}"`);
      return result.trim() === '1';
    } catch {
      return false;
    }
  }

  /**
   * Get current scroll position (0 = at bottom)
   */
  getScrollPosition() {
    try {
      const result = this.runCommand(`display-message -t ${this.name} -p "#{scroll_position}"`);
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  // ==================== Window Queries ====================

  /**
   * Get window count
   */
  getWindowCount() {
    const result = this.runCommand(`list-windows -t ${this.name} -F "#{window_index}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get current window index
   */
  getCurrentWindowIndex() {
    return this.runCommand(`display-message -t ${this.name} -p "#{window_index}"`);
  }

  /**
   * Get window info
   */
  getWindowInfo() {
    const result = this.runCommand(
      `list-windows -t ${this.name} -F "#{window_index}|#{window_name}|#{window_active}"`
    );
    return result.split('\n').filter(line => line.trim()).map(line => {
      const [index, name, active] = line.split('|');
      return {
        index: parseInt(index, 10),
        name,
        active: active === '1',
      };
    });
  }

  // ==================== Commands ====================

  /**
   * Send keys to the session
   */
  sendKeys(keys) {
    this.runCommand(`send-keys -t ${this.name} ${keys}`);
  }

  /**
   * Capture session content using the Rust binary
   */
  captureSnapshot() {
    const captureScript = path.join(WORKSPACE_ROOT, 'target/release/tmux-capture');
    const captureScriptDebug = path.join(WORKSPACE_ROOT, 'target/debug/tmux-capture');

    let binaryPath = captureScript;
    if (!fs.existsSync(binaryPath)) {
      binaryPath = captureScriptDebug;
      if (!fs.existsSync(binaryPath)) {
        throw new Error('tmux-capture binary not found. Run: cargo build -p tmuxy-core --bin tmux-capture');
      }
    }

    const result = execSync(`${binaryPath} ${this.name} 200`, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf-8',
    }).trim();

    if (fs.existsSync(result)) {
      return fs.readFileSync(result, 'utf-8');
    }
    throw new Error(`Snapshot file not found: ${result}`);
  }
}

module.exports = TmuxTestSession;
