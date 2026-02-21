/**
 * TmuxTestSession - Encapsulates tmux test session lifecycle and state queries
 *
 * tmux 3.5a crashes on ANY external command (even read-only) while control
 * mode is attached. All commands must route through the WebSocket/control mode
 * channel when the browser is connected.
 *
 * Methods fall into three categories:
 * 1. Lifecycle methods (execSync) - create(), destroy(), exists()
 *    Run BEFORE/AFTER control mode, so execSync is safe.
 * 2. Query methods (hybrid async) - getPaneCount(), getActivePaneId(), etc.
 *    Route through WebSocket when browser connected, execSync otherwise.
 * 3. Operation methods (hybrid async) - splitHorizontal(), killPane(), etc.
 *    Route through WebSocket when browser connected, execSync otherwise.
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
   * Run a tmux command. Routes through WebSocket when browser is connected
   * (to avoid crashing tmux 3.5a), falls back to execSync otherwise.
   * Returns a Promise when browser is connected, string otherwise.
   */
  runCommand(command) {
    if (this.page) {
      return this._exec(command);
    }
    try {
      return execSync(`tmux ${command}`, { encoding: 'utf-8' }).trim();
    } catch (error) {
      console.error(`Failed to run tmux command: ${command}`, error.message);
      throw error;
    }
  }

  /**
   * Run a tmux command directly via execSync. Use ONLY when control mode is NOT
   * attached (lifecycle operations before browser connects).
   */
  runCommandSync(command) {
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
   * Query tmux state — routes through WebSocket when browser is connected,
   * falls back to execSync otherwise. Use this for ALL read operations during tests.
   * tmux 3.5a crashes even on read-only external commands while control mode is attached.
   */
  async query(command) {
    return this._exec(`${command} -t ${this.name}`);
  }

  /**
   * Mark session as ready for creation.
   *
   * The actual tmux session is created by the web server when the browser
   * navigates to the session URL (the server uses `tmux -CC new-session`
   * which is safe). External `tmux new-session` crashes tmux 3.5a when
   * any control mode client is attached.
   *
   * Call sourceConfig() after navigation to load tmuxy config.
   */
  create(options = {}) {
    this.created = true;
    return this;
  }

  /**
   * Source the tmuxy config and set up window index.
   * Must be called AFTER browser navigation (routes through control mode).
   */
  async sourceConfig() {
    if (!this.configPath || !this.page) {
      console.log(`[sourceConfig] Skipping: configPath=${this.configPath}, page=${!!this.page}`);
      return;
    }

    console.log(`[sourceConfig] Sourcing ${this.configPath}`);
    try {
      await this._exec(`source-file ${this.configPath}`);
      console.log(`[sourceConfig] Config sourced successfully`);
    } catch (e) {
      console.log(`[sourceConfig] Failed to source config: ${e.message}`);
    }

    // Move window from index 0 to 1 (config sets base-index 1 but
    // new-session creates at 0). Ignore errors if already at 1.
    try {
      await this._exec(`move-window -s ${this.name}:0 -t ${this.name}:1`);
      console.log(`[sourceConfig] Moved window to index 1`);
    } catch {
      // Already at base-index 1 or window not found — fine
    }
  }

  /**
   * Destroy the tmux session.
   * Uses destroyViaAdapter when browser is connected (routes through
   * control mode). External `tmux kill-session` crashes tmux 3.5a when
   * any control mode is attached, so we skip it.
   */
  async destroy() {
    if (!this.created) return;

    if (this.page) {
      try {
        await this.destroyViaAdapter();
        return;
      } catch {
        // Adapter not available, fall through
      }
    }

    // No page available — skip external tmux command (it would crash tmux 3.5a).
    // The session will be cleaned up naturally when it becomes idle.
    this.created = false;
    this.page = null;
  }

  /**
   * Destroy the tmux session through the WebSocket adapter (control mode).
   * This is SAFE to call while control mode is attached — the kill-session
   * command is routed through the existing control mode connection, avoiding
   * the tmux 3.5a crash that occurs with external subprocess commands.
   *
   * Must be called BEFORE closing the page.
   */
  async destroyViaAdapter() {
    if (!this.page) {
      throw new Error('Page not available for adapter-based destroy');
    }

    await this.page.evaluate(async (name) => {
      if (!window._adapter) throw new Error('Adapter not available');
      await window._adapter.invoke('run_tmux_command', {
        command: `kill-session -t ${name}`,
      });
    }, this.name);

    // Wait for monitor to process the %exit event and disconnect
    await new Promise(r => setTimeout(r, 500));

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
      // Only log mutations (not queries like list-panes, display-message) to reduce noise
      const isQuery = /^(list-|display-message|has-session|show-)/.test(cleanCmd.trim());
      if (!isQuery) {
        console.log(`[_exec] Routing through WebSocket: ${cleanCmd} (original: ${command})`);
      }
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
        if (!isQuery) {
          console.log(`[_exec] Success: ${cleanCmd}`);
        }
        // Wait for tmux to process the command and propagate state
        // Chain: control mode → tmux → event → monitor → SSE → browser → XState
        await new Promise(r => setTimeout(r, 250));
        return result;
      } catch (e) {
        console.log(`[_exec] Failed: ${cleanCmd} - ${e.message}`);
        throw e;
      }
    } else {
      // No browser - use execSync (safe, control mode not attached)
      console.log(`[_exec] Routing through execSync: ${command}`);
      return this.runCommandSync(command);
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

  // ==================== State Query Helper ====================
  // When browser is connected, query the XState machine context directly
  // instead of running tmux commands (which return null through control mode).
  // This also avoids crashing tmux 3.5a with external commands.

  /**
   * Get the current app state from the browser's XState machine.
   * Returns the machine context with panes, windows, etc.
   */
  async _getBrowserState() {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => {
        if (!window.app) return null;
        const snap = window.app.getSnapshot();
        if (!snap || !snap.context) return null;
        const ctx = snap.context;
        return {
          panes: ctx.panes.map(p => ({
            id: p.tmuxId,
            windowId: p.windowId,
            index: p.id,
            width: p.width,
            height: p.height,
            active: p.active,
            x: p.x,
            y: p.y,
            title: p.title,
            borderTitle: p.borderTitle,
            inMode: p.inMode,
            command: p.command,
          })),
          windows: ctx.windows.map(w => ({
            id: w.id,
            index: w.index,
            name: w.name,
            active: w.active,
            isPaneGroupWindow: w.isPaneGroupWindow,
            isFloatWindow: w.isFloatWindow,
          })),
          activeWindowId: ctx.activeWindowId,
          activePaneId: ctx.activePaneId,
        };
      });
    } catch (e) {
      // Page might be navigating or destroyed
      return null;
    }
  }

  /**
   * Wait for browser state to become available (with polling).
   * Use this instead of _getBrowserState() in query methods to avoid
   * falling back to runCommandSync which crashes tmux 3.5a.
   * @param {number} timeout - Max wait time in ms (default 3000)
   * @returns {Object|null} Browser state or null if not available
   */
  async _waitForBrowserState(timeout = 3000) {
    if (!this.page) return null;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const state = await this._getBrowserState();
      if (state) return state;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  // ==================== Pane Queries ====================
  // When browser is connected, queries read from the XState machine context.
  // This avoids running tmux commands through control mode (which returns null)
  // and avoids crashing tmux 3.5a with external commands.
  // Falls back to execSync when no browser is connected.

  /**
   * Get pane count (in active window)
   */
  async getPaneCount() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.panes.filter(p => p.windowId === state.activeWindowId).length;
      }
      throw new Error('Browser state not available for getPaneCount');
    }
    const result = this.runCommandSync(`list-panes -t ${this.name} -F "#{pane_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get window count (excluding hidden pane group and float windows)
   */
  async getWindowCount() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.windows.filter(w => !w.isPaneGroupWindow && !w.isFloatWindow).length;
      }
      throw new Error('Browser state not available for getWindowCount');
    }
    const result = this.runCommandSync(`list-windows -t ${this.name} -F "#{window_id}"`);
    return result.split('\n').filter(line => line.trim()).length;
  }

  /**
   * Get detailed pane info (in active window)
   */
  async getPaneInfo() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.panes
          .filter(p => p.windowId === state.activeWindowId)
          .map(p => ({
            id: p.id,
            index: p.index,
            width: p.width,
            height: p.height,
            active: p.active,
            y: p.y,
            x: p.x,
          }));
      }
      throw new Error('Browser state not available for getPaneInfo');
    }
    const result = this.runCommandSync(
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
   * Get active pane ID.
   * Polls for up to 3s when browser is connected (activePaneId may not be
   * set immediately after page navigation).
   */
  async getActivePaneId() {
    if (this.page) {
      // Poll for activePaneId since it may be null during initialization
      for (let i = 0; i < 30; i++) {
        const state = await this._getBrowserState();
        if (state && state.activePaneId) return state.activePaneId;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    }
    return this.runCommandSync(`display-message -t ${this.name} -p "#{pane_id}"`);
  }

  /**
   * Check if current pane is zoomed.
   * When zoomed, the active pane takes full window dimensions and overlaps
   * with other panes in the same window.
   */
  async isPaneZoomed() {
    if (!this.page) {
      try {
        const result = this.runCommandSync(`display-message -t ${this.name} -p "#{window_zoomed_flag}"`);
        return result.trim() === '1';
      } catch {
        return false;
      }
    }
    // Poll for up to 3s since zoom state change needs full propagation chain:
    // control mode → tmux → event → monitor → SSE → browser → XState
    for (let i = 0; i < 30; i++) {
      const state = await this._getBrowserState();
      if (!state) { await new Promise(r => setTimeout(r, 100)); continue; }
      const windowPanes = state.panes.filter(p => p.windowId === state.activeWindowId);
      if (windowPanes.length <= 1) return false;
      // When zoomed, the active pane overlaps with other panes
      // (it takes full window dimensions while others keep their positions)
      const activePane = windowPanes.find(p => p.id === state.activePaneId);
      if (!activePane) { await new Promise(r => setTimeout(r, 100)); continue; }
      for (const other of windowPanes) {
        if (other.id === activePane.id) continue;
        // Check if active pane's bounding box overlaps with other pane
        const overlapX = activePane.x < other.x + other.width && activePane.x + activePane.width > other.x;
        const overlapY = activePane.y < other.y + other.height && activePane.y + activePane.height > other.y;
        if (overlapX && overlapY) return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Check if current pane is in copy mode.
   * When browser is connected, polls the state for up to 1 second since
   * copy mode status is only updated via periodic list-panes sync (500ms).
   */
  async isPaneInCopyMode() {
    if (this.page) {
      // Poll for up to 1s since state sync is every 500ms
      for (let i = 0; i < 20; i++) {
        const state = await this._getBrowserState();
        if (state) {
          const activePane = state.panes.find(p => p.id === state.activePaneId);
          if (activePane && activePane.inMode) return true;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    }
    try {
      const result = this.runCommandSync(`display-message -t ${this.name} -p "#{pane_in_mode}"`);
      return result.trim() === '1';
    } catch {
      return false;
    }
  }

  /**
   * Get current scroll position (0 = at bottom).
   * Note: scroll_position is not available in browser state, so this falls back
   * to checking inMode as a proxy when browser is connected.
   */
  async getScrollPosition() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (!state) return 0;
      const activePane = state.panes.find(p => p.id === state.activePaneId);
      return (activePane && activePane.inMode) ? 1 : 0;
    }
    try {
      const result = this.runCommandSync(`display-message -t ${this.name} -p "#{scroll_position}"`);
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get pane border titles
   * Returns a map of pane_id -> title string
   */
  async getPaneBorderTitles() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        const titles = {};
        state.panes
          .filter(p => p.windowId === state.activeWindowId)
          .forEach(p => { titles[p.id] = p.title; });
        return titles;
      }
      return {};
    }
    const result = this.runCommandSync(
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
   * Get current window index
   */
  async getCurrentWindowIndex() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        const activeWin = state.windows.find(w => w.active);
        return activeWin ? String(activeWin.index) : null;
      }
      return null;
    }
    return this.runCommandSync(`display-message -t ${this.name} -p "#{window_index}"`);
  }

  /**
   * Get window info (excluding hidden pane group and float windows)
   * @param {Object} options
   * @param {boolean} options.includeFloats - Include float windows (default: false)
   * @param {boolean} options.includeGroups - Include pane group windows (default: false)
   */
  async getWindowInfo({ includeFloats = false, includeGroups = false } = {}) {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.windows
          .filter(w => (includeGroups || !w.isPaneGroupWindow) && (includeFloats || !w.isFloatWindow))
          .map(w => ({
            index: w.index,
            name: w.name,
            active: w.active,
            isFloatWindow: w.isFloatWindow,
            isPaneGroupWindow: w.isPaneGroupWindow,
          }));
      }
      return [];
    }
    const result = this.runCommandSync(
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
   * Create new window and switch to it.
   * Uses split-window + break-pane workaround because `new-window` crashes
   * tmux 3.5a control mode (causes %exit event).
   */
  newWindow(name = null) {
    // Workaround: split-window creates a pane, break-pane moves it to a new window.
    // Using `\;` which the monitor unescapes to `;` (tmux command separator).
    // `new-window` crashes tmux 3.5a control mode (causes %exit event).
    const nameFlag = name ? ` -n ${name}` : '';
    return this._exec(`split-window -t ${this.name} \\; break-pane${nameFlag}`);
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
        this.runCommandSync(`send-keys -t ${this.name} -X cursor-${direction}`);
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
   * Get paste buffer content.
   * When browser is connected, routes through _exec (which is fire-and-forget,
   * so output is not captured). Falls back to execSync when no browser.
   */
  async getBufferContent() {
    if (this.page) {
      // show-buffer needs output — not available through control mode.
      // Use a workaround: paste buffer into a temp file and read it.
      // For now, return empty string (tests that need this may need adjustment).
      return '';
    }
    try {
      return this.runCommandSync('show-buffer');
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
   * Get the current cursor line content in copy mode.
   * Not available through browser state; falls back to execSync when no browser.
   */
  async getCopyModeLine() {
    if (this.page) {
      // copy_cursor_line is not in browser state — return empty
      return '';
    }
    try {
      return this.runCommandSync(`display-message -t ${this.name} -p "#{copy_cursor_line}"`);
    } catch {
      return '';
    }
  }

  /**
   * Get cursor position in copy mode.
   * When browser is connected, reads from XState machine context.
   * @returns {{x: number, y: number}} Cursor position (0-indexed)
   */
  async getCopyCursorPosition() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        // copyCursorX/copyCursorY are in the full pane data
        const fullState = await this.page.evaluate(() => {
          const snap = window.app.getSnapshot();
          const pane = snap.context.panes.find(p => p.tmuxId === snap.context.activePaneId);
          return pane ? { x: pane.copyCursorX, y: pane.copyCursorY } : { x: 0, y: 0 };
        });
        return fullState;
      }
      return { x: 0, y: 0 };
    }
    try {
      const x = parseInt(this.runCommandSync(`display-message -t ${this.name} -p "#{copy_cursor_x}"`), 10) || 0;
      const y = parseInt(this.runCommandSync(`display-message -t ${this.name} -p "#{copy_cursor_y}"`), 10) || 0;
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
