/**
 * TmuxTestSession - Encapsulates tmux test session lifecycle and state queries
 *
 * Key insight: Read-only tmux queries are safe to run via execSync even when
 * control mode is attached. Only MODIFYING commands (split, kill, resize, etc.)
 * cause tmux 3.3a crashes when run externally during control mode.
 *
 * Methods fall into three categories:
 * 1. Lifecycle methods (execSync) - create(), destroy(), exists()
 * 2. Query methods (execSync) - getPaneCount(), getActivePaneId(), etc.
 *    These are read-only and safe to run externally.
 * 3. Operation methods (hybrid) - splitHorizontal(), killPane(), etc.
 *    Uses WebSocket when browser connected, execSync otherwise.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WORKSPACE_ROOT } = require('./config');

/**
 * Get the path to the tmuxy config file
 * Checks ~/.tmuxy.conf first, then falls back to docker/.tmuxy.conf
 */
function getTmuxConfigPath() {
  const homeConfig = path.join(os.homedir(), '.tmuxy.conf');
  if (fs.existsSync(homeConfig)) {
    return homeConfig;
  }
  const dockerConfig = path.join(WORKSPACE_ROOT, 'docker', '.tmuxy.conf');
  if (fs.existsSync(dockerConfig)) {
    return dockerConfig;
  }
  return null;
}

class TmuxTestSession {
  constructor(name = null) {
    this.name = name || `tmuxy_test_${Date.now()}`;
    this.created = false;
    this.configPath = getTmuxConfigPath();
    this.page = null; // Set after browser navigation
  }

  /**
   * Set the Playwright page for WebSocket routing.
   * Must be called after browser navigation.
   */
  setPage(page) {
    this.page = page;
  }

  /**
   * Check if browser is connected (page is set)
   */
  isBrowserConnected() {
    return this.page !== null;
  }

  // ==================== Lifecycle Methods (always execSync) ====================
  // These run BEFORE control mode is attached, so they're safe as execSync

  /**
   * Run a tmux command directly (for lifecycle operations only)
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
   * Run a tmux command targeting this session (for lifecycle operations only)
   */
  run(command) {
    return this.runCommand(`${command} -t ${this.name}`);
  }

  /**
   * Create the tmux session with tmuxy config
   */
  create(options = {}) {
    const { width = 120, height = 30 } = options;

    try {
      execSync(`tmux has-session -t ${this.name} 2>/dev/null`, { stdio: 'ignore' });
      console.log(`Session ${this.name} already exists`);
    } catch {
      // Create new session
      execSync(`tmux new-session -d -s ${this.name} -x ${width} -y ${height}`, { stdio: 'inherit' });
      console.log(`Created tmux session: ${this.name}${this.configPath ? ' (with config)' : ''}`);
    }

    // Always source config after session creation/check
    if (this.configPath) {
      execSync(`tmux source-file ${this.configPath}`, { stdio: 'ignore' });

      // Ensure initial window is at base-index (1) for test consistency
      try {
        const currentIndex = execSync(
          `tmux display-message -t ${this.name} -p "#{window_index}"`,
          { encoding: 'utf-8' }
        ).trim();
        if (currentIndex === '0') {
          execSync(`tmux move-window -s ${this.name}:0 -t ${this.name}:1`, { stdio: 'ignore' });
        }
      } catch {
        // Ignore if we can't get/move window
      }
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
    this.page = null;
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

  // ==================== Hybrid Command Execution ====================

  /**
   * Execute a tmux command - via WebSocket if browser connected, execSync otherwise.
   * This is the core hybrid routing mechanism.
   * @param {string} command - Full tmux command
   * @returns {Promise<string>|string} - Result (async if browser connected)
   */
  /**
   * Execute a tmux command - via WebSocket if browser connected, execSync otherwise.
   * This is the core hybrid routing mechanism.
   *
   * IMPORTANT: Control mode is already attached to the session, so when routing
   * through WebSocket, we strip the `-t session_name` from commands to avoid
   * double-targeting which can cause issues with tmux 3.3a.
   *
   * @param {string} command - Full tmux command (may include -t session targeting)
   * @returns {Promise<string>|string} - Result (async if browser connected)
   */
  async _exec(command) {
    if (this.page) {
      // Browser connected - use WebSocket to avoid crashing control mode
      // Strip session name from -t targets, but preserve window:pane suffixes
      // e.g., "-t session:2" becomes "-t :2", "-t session" is removed
      let cleanCmd = command;
      const targetRegex = new RegExp(` -t ${this.name}(:[^\\s]+)?`, 'g');
      cleanCmd = command.replace(targetRegex, (match, suffix) => {
        if (suffix) {
          // Preserve the window:pane suffix (e.g., :1 or :.+ or :%5)
          return ` -t ${suffix}`;
        }
        // No suffix, just remove the session target
        return '';
      });
      console.log(`[_exec] Routing through WebSocket: ${cleanCmd} (original: ${command})`);
      try {
        const result = await this.page.evaluate(async (cmd) => {
          if (!window._adapter) {
            throw new Error('Adapter not available - is dev mode enabled?');
          }
          // Retry on transient failures (monitor not ready yet)
          // Monitor connection can take 1-2 seconds to establish
          let lastError = null;
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              return await window._adapter.invoke('run_tmux_command', { command: cmd });
            } catch (e) {
              lastError = e;
              if (e.message?.includes('No monitor connection')) {
                // Wait for monitor to connect (exponential backoff: 100, 200, 400, ...)
                await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
                continue;
              }
              throw e; // Non-transient error, rethrow
            }
          }
          throw lastError || new Error('Failed after retries');
        }, cleanCmd);
        console.log(`[_exec] Success: ${cleanCmd}`);
        // Wait a bit for tmux to process the command before returning
        // This prevents race conditions with cleanup
        await new Promise(r => setTimeout(r, 100));
        return result;
      } catch (e) {
        console.log(`[_exec] Failed: ${cleanCmd} - ${e.message}`);
        throw e;
      }
    } else {
      // No browser - use execSync (safe, control mode not attached)
      console.log(`[_exec] Routing through execSync: ${command}`);
      return this.runCommand(command);
    }
  }

  /**
   * Execute a tmux command targeting this session.
   * @param {string} command - Command with -t placeholder for session
   * @returns {Promise<string>|string}
   */
  _execSession(command) {
    return this._exec(`${command} -t ${this.name}`);
  }

  /**
   * Run a tmux command via the browser's WebSocket adapter.
   * Use this when you explicitly need WebSocket routing.
   * @param {string} command - tmux command
   */
  async runViaAdapter(command) {
    if (!this.page) {
      throw new Error('Page not set - call setPage() after navigation');
    }
    return this.page.evaluate(async (cmd) => {
      if (!window._adapter) {
        throw new Error('Adapter not available - is dev mode enabled?');
      }
      return window._adapter.invoke('run_tmux_command', { command: cmd });
    }, command);
  }

  /**
   * Wait for browser state to match expected condition.
   * @param {Function} predicateFn - Function that receives context and returns true when met
   * @param {number} timeout - Max wait time in ms (default 5000)
   */
  async waitForState(predicateFn, timeout = 5000) {
    if (!this.page) {
      throw new Error('Page not set - call setPage() after navigation');
    }

    const predicateStr = predicateFn.toString();
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = await this.page.evaluate((fnStr) => {
        const fn = eval(`(${fnStr})`);
        const snapshot = window.app?.getSnapshot?.();
        if (!snapshot) return false;
        return fn(snapshot.context);
      }, predicateStr);

      if (result) return;
      await new Promise(r => setTimeout(r, 50));
    }

    throw new Error(`State condition not met within ${timeout}ms`);
  }

  // ==================== Pane Queries ====================

  /**
   * Get pane count - uses execSync (read-only queries are safe)
   */
  getPaneCount() {
    const result = this.runCommand(`list-panes -t ${this.name} -F "#{pane_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get window count - uses execSync (read-only queries are safe)
   */
  getWindowCount() {
    const result = this.runCommand(`list-windows -t ${this.name} -F "#{window_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get detailed pane info - uses execSync (read-only queries are safe)
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
   * Get active pane ID - uses execSync (read-only queries are safe)
   */
  getActivePaneId() {
    return this.runCommand(`display-message -t ${this.name} -p "#{pane_id}"`);
  }

  /**
   * Check if current pane is zoomed - uses execSync (read-only queries are safe)
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
   * Check if current pane is in copy mode - uses execSync (read-only queries are safe)
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
   * Get current scroll position (0 = at bottom) - uses execSync (read-only queries are safe)
   */
  getScrollPosition() {
    try {
      const result = this.runCommand(`display-message -t ${this.name} -p "#{scroll_position}"`);
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get pane border titles - uses execSync (read-only queries are safe)
   * Returns a map of pane_id -> border title string
   */
  getPaneBorderTitles() {
    const result = this.runCommand(
      `list-panes -t ${this.name} -F "#{pane_id}|#{pane_title}"`
    );
    const titles = {};
    result.split('\n').filter(line => line.trim()).forEach(line => {
      const sep = line.indexOf('|');
      if (sep !== -1) {
        titles[line.slice(0, sep)] = line.slice(sep + 1);
      }
    });
    return titles;
  }

  // ==================== Window Queries ====================

  /**
   * Get current window index - uses execSync (read-only queries are safe)
   */
  getCurrentWindowIndex() {
    return this.runCommand(`display-message -t ${this.name} -p "#{window_index}"`);
  }

  /**
   * Get window info - uses execSync (read-only queries are safe)
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

  // ==================== Pane Operations ====================

  /**
   * Split pane horizontally (creates pane below)
   */
  splitHorizontal() {
    return this._exec(`split-window -t ${this.name} -v`);
  }

  /**
   * Split pane vertically (creates pane to the right)
   */
  splitVertical() {
    return this._exec(`split-window -t ${this.name} -h`);
  }

  /**
   * Navigate to pane in direction
   * @param {string} direction - 'U', 'D', 'L', 'R' for up, down, left, right
   */
  selectPane(direction) {
    return this._exec(`select-pane -t ${this.name} -${direction}`);
  }

  /**
   * Cycle to next pane
   */
  nextPane() {
    return this._exec(`select-pane -t ${this.name}:.+`);
  }

  /**
   * Toggle pane zoom
   */
  toggleZoom() {
    return this._exec(`resize-pane -t ${this.name} -Z`);
  }

  /**
   * Swap pane with another
   * @param {string} direction - 'U', 'D' for up/down swap
   */
  swapPane(direction) {
    const flag = direction === 'U' ? '-U' : '-D';
    return this._exec(`swap-pane -t ${this.name} ${flag}`);
  }

  /**
   * Kill current pane
   */
  killPane() {
    return this._exec(`kill-pane -t ${this.name}`);
  }

  /**
   * Create new window and switch to it
   */
  newWindow() {
    return this._exec(`new-window -t ${this.name}`);
  }

  /**
   * Break pane to new window
   */
  breakPane() {
    return this._exec(`break-pane -t ${this.name}`);
  }

  /**
   * Enter copy mode
   */
  enterCopyMode() {
    return this._exec(`copy-mode -t ${this.name}`);
  }

  /**
   * Exit copy mode by sending 'q'
   */
  exitCopyMode() {
    return this._exec(`send-keys -t ${this.name} q`);
  }

  // ==================== Window Operations ====================

  /**
   * Select window by index
   */
  selectWindow(index) {
    return this._exec(`select-window -t ${this.name}:${index}`);
  }

  /**
   * Switch to next window
   */
  nextWindow() {
    return this._exec(`next-window -t ${this.name}`);
  }

  /**
   * Switch to previous window
   */
  previousWindow() {
    return this._exec(`previous-window -t ${this.name}`);
  }

  /**
   * Switch to last visited window
   */
  lastWindow() {
    return this._exec(`last-window -t ${this.name}`);
  }

  /**
   * Kill window by index
   */
  killWindow(index) {
    return this._exec(`kill-window -t ${this.name}:${index}`);
  }

  /**
   * Rename current window
   */
  renameWindow(name) {
    return this._exec(`rename-window -t ${this.name} "${name}"`);
  }

  /**
   * Set window layout
   */
  selectLayout(layoutName) {
    return this._exec(`select-layout -t ${this.name} ${layoutName}`);
  }

  /**
   * Cycle to next layout
   */
  nextLayout() {
    return this._exec(`next-layout -t ${this.name}`);
  }

  // ==================== Copy Mode Operations ====================

  /**
   * Start visual selection in copy mode (vi: v)
   */
  beginSelection() {
    return this._exec(`send-keys -t ${this.name} -X begin-selection`);
  }

  /**
   * Copy selection and exit copy mode (vi: y)
   */
  copySelection() {
    return this._exec(`send-keys -t ${this.name} -X copy-selection-and-cancel`);
  }

  /**
   * Move cursor in copy mode
   * @param {string} direction - 'up', 'down', 'left', 'right'
   * @param {number} count - Number of times to move
   */
  copyModeMove(direction, count = 1) {
    // For sync mode, run all moves
    if (!this.page) {
      for (let i = 0; i < count; i++) {
        this.runCommand(`send-keys -t ${this.name} -X cursor-${direction}`);
      }
      return;
    }
    // For async mode, chain promises
    return (async () => {
      for (let i = 0; i < count; i++) {
        await this._exec(`send-keys -t ${this.name} -X cursor-${direction}`);
      }
    })();
  }

  /**
   * Go to beginning of line in copy mode
   */
  copyModeStartOfLine() {
    return this._exec(`send-keys -t ${this.name} -X start-of-line`);
  }

  /**
   * Go to end of line in copy mode
   */
  copyModeEndOfLine() {
    return this._exec(`send-keys -t ${this.name} -X end-of-line`);
  }

  /**
   * Paste from tmux buffer
   */
  pasteBuffer() {
    return this._exec(`paste-buffer -t ${this.name}`);
  }

  /**
   * Get paste buffer content - uses execSync (read-only queries are safe)
   */
  getBufferContent() {
    try {
      return this.runCommand('show-buffer');
    } catch {
      return '';
    }
  }

  /**
   * Search forward in copy mode
   */
  copyModeSearchForward(pattern) {
    return this._exec(`send-keys -t ${this.name} -X search-forward "${pattern}"`);
  }

  /**
   * Get the current cursor line content in copy mode - uses execSync (read-only queries are safe)
   */
  getCopyModeLine() {
    try {
      return this.runCommand(`display-message -t ${this.name} -p "#{copy_cursor_line}"`);
    } catch {
      return '';
    }
  }

  /**
   * Get cursor position in copy mode - uses execSync (read-only queries are safe)
   * @returns {{x: number, y: number}} Cursor position (0-indexed)
   */
  getCopyCursorPosition() {
    try {
      const x = parseInt(this.runCommand(`display-message -t ${this.name} -p "#{copy_cursor_x}"`), 10) || 0;
      const y = parseInt(this.runCommand(`display-message -t ${this.name} -p "#{copy_cursor_y}"`), 10) || 0;
      return { x, y };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  // ==================== Resize Operations ====================

  /**
   * Resize pane
   * @param {string} direction - 'U', 'D', 'L', 'R'
   * @param {number} amount - Number of cells to resize
   */
  resizePane(direction, amount = 5) {
    return this._exec(`resize-pane -t ${this.name} -${direction} ${amount}`);
  }

  // ==================== Commands ====================

  /**
   * Send keys to the session
   */
  sendKeys(keys) {
    return this._exec(`send-keys -t ${this.name} ${keys}`);
  }

  /**
   * Capture session content using the Rust binary
   * Note: This runs externally but doesn't use control mode, so it's safe
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
