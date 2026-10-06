/**
 * TmuxTestSession - Encapsulates tmux test session lifecycle and state queries
 *
 * All mutating commands route through the tmuxy CLI (`tmuxy run ...`) which uses
 * `tmux run-shell` to avoid crashing tmux 3.5a control mode.
 *
 * State queries use either:
 * - The browser's XState machine context (when page is connected) for accurate UI state
 * - Read-only `tmux` queries (when no page), which are safe with control mode attached
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WORKSPACE_ROOT, waitBudget } = require('./config');
const { tmuxRun } = require('./cli');
const { tmuxCmd, tmuxExec } = require('./tmux-socket');
const { delay, waitForCondition } = require('./browser');
const { reapPids } = require('./reap');

/**
 * Get the path to the tmuxy config file
 * Checks ~/.tmuxy.conf first, then falls back to .devcontainer/.tmuxy.conf
 */
function getTmuxConfigPath() {
  const homeConfig = path.join(os.homedir(), '.tmuxy.conf');
  if (fs.existsSync(homeConfig)) {
    return homeConfig;
  }
  const dockerConfig = path.join(WORKSPACE_ROOT, '.devcontainer', '.tmuxy.conf');
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
   * Set the Playwright page for adapter routing.
   * Must be called after browser navigation.
   */
  setPage(page) {
    this.page = page;
  }

  /**
   * Run a tmux command. Read-only verbs (safe as external subprocesses with
   * control mode attached, per docs/TMUX.md) run directly; every other command
   * routes through the tmuxy CLI (`tmux run-shell`), since an external mutation
   * while control mode is attached crashes tmux 3.5a.
   */
  runCommand(command) {
    const readOnly =
      /^(has-session|capture-pane|display-message|list-[a-z]+|show-options|list-keys)\b/;
    return readOnly.test(command) ? tmuxExec(command) : tmuxRun(command);
  }

  /** Run a tmux command against this session (`-t <name>` appended). */
  async query(command) {
    return this.runCommand(`${command} -t ${this.name}`);
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
  create() {
    this.created = true;
    return this;
  }

  /**
   * Source the tmuxy config and set up window index.
   */
  async sourceConfig() {
    if (!this.configPath) {
      return;
    }

    try {
      this.runCommand(`source-file ${this.configPath}`);
    } catch (e) {
      throw new Error(`Failed to source config ${this.configPath}: ${e.message}`);
    }

    // Move window from index 0 to 1 (config sets base-index 1 but
    // new-session creates at 0). Ignore errors if already at 1.
    try {
      this.runCommand(`move-window -s ${this.name}:0 -t ${this.name}:1`);
    } catch {
      // Already at base-index 1 or window not found — fine
    }

    // run-shell returns once tmux has run both commands; wait for the UI to
    // have seen the move too, so the test starts from the state it will read.
    if (this.page) {
      await this.waitForState(
        (ctx) => !ctx.windows.some((w) => w.windowType === 'tab' && w.index === 0),
      );
    }
  }

  /**
   * Destroy the tmux session (kill-session through run-shell, like every
   * other mutation).
   *
   * The pane pids are read BEFORE the kill, because afterwards there is no
   * session to list them from. tmux closes each PTY master immediately after
   * the SIGHUP, so a shell still inside its own start-up never returns from
   * opening its controlling terminal and hangs in the kernel holding a PTY
   * slave open — one orphan per pane, until the machine runs out of
   * pseudoterminals (see `bin/tmuxy/reap-orphan-shells`).
   */
  async destroy() {
    if (!this.created) return;

    let panePids = [];
    try {
      panePids = tmuxExec(`list-panes -s -t ${this.name} -F '#{pane_pid}'`)
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    } catch {
      // No session to list — nothing to follow up on either
    }

    try {
      this.runCommand(`kill-session -t ${this.name}`);
    } catch {
      // Session may already be gone
    }

    // Wait for the monitor to process the %exit event and disconnect.
    await waitForCondition(null, () => !this.exists(), 5000, `session ${this.name} to be gone`);

    reapPids(panePids);

    this.created = false;
    this.page = null;
  }

  /**
   * Check if session exists
   */
  exists() {
    try {
      execSync(`${tmuxCmd()} has-session -t ${this.name} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for browser state to match expected condition.
   *
   * The predicate is STRINGIFIED and re-evaluated in the page, so it must not
   * close over test-scope variables — pass them via `arg` instead:
   *   session.waitForState((ctx, id) => ctx.activePaneId === id, paneId)
   * (A closure would silently see `undefined` in the page, which is how this
   * helper used to "pass" while asserting nothing.)
   *
   * @param {Function} predicateFn - (context, arg) => boolean
   * @param {*} [arg] - Serializable value forwarded to the predicate
   * @param {number} timeout - Max wait time in ms (default 5000)
   */
  async waitForState(predicateFn, arg = undefined, timeout = 5000) {
    if (!this.page) {
      throw new Error('Page not set - call setPage() after navigation');
    }

    const predicateStr = predicateFn.toString();
    const deadline = Date.now() + waitBudget(timeout);

    while (Date.now() < deadline) {
      const result = await this.page.evaluate(
        ({ fnStr, fnArg }) => {
          const fn = eval(`(${fnStr})`);
          const snapshot = window.app?.getSnapshot?.();
          if (!snapshot) return false;
          return fn(snapshot.context, fnArg);
        },
        { fnStr: predicateStr, fnArg: arg },
      );

      if (result) return;
      await delay(50);
    }

    throw new Error(`State condition not met within ${timeout}ms`);
  }

  // ==================== State Query Helper ====================
  // When browser is connected, query the XState machine context directly:
  // the tests assert what the UI shows, not what tmux holds.

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
          panes: ctx.panes.map((p) => ({
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
          windows: ctx.windows.map((w) => ({
            id: w.id,
            index: w.index,
            name: w.name,
            active: w.active,
            windowType: w.windowType,
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
   * The page can be mid-navigation for a moment, so a query method waits
   * for the state rather than reading it once.
   * @param {number} timeout - Max wait time in ms (default 3000)
   * @returns {Object|null} Browser state or null if not available
   */
  async _waitForBrowserState(timeout = 3000) {
    if (!this.page) return null;
    const deadline = Date.now() + waitBudget(timeout);
    while (Date.now() < deadline) {
      const state = await this._getBrowserState();
      if (state) return state;
      await delay(100);
    }
    return null;
  }

  // ==================== Pane Queries ====================
  // When browser is connected, queries read from the XState machine context;
  // without one they fall back to read-only tmux queries.

  /**
   * Get pane count (in active window)
   */
  async getPaneCount() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.panes.filter((p) => p.windowId === state.activeWindowId).length;
      }
      throw new Error('Browser state not available for getPaneCount');
    }
    const result = tmuxExec(`list-panes -t ${this.name} -F "#{pane_id}"`);
    return result.split('\n').filter((line) => line.trim()).length;
  }

  /**
   * Get window count (tabs only)
   */
  async getWindowCount() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.windows.filter((w) => w.windowType === 'tab').length;
      }
      throw new Error('Browser state not available for getWindowCount');
    }
    const result = tmuxExec(`list-windows -t ${this.name} -F "#{window_id}"`);
    return result.split('\n').filter((line) => line.trim()).length;
  }

  /**
   * Get detailed pane info (in active window)
   */
  async getPaneInfo() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.panes
          .filter((p) => p.windowId === state.activeWindowId)
          .map((p) => ({
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
    const result = tmuxExec(
      `list-panes -t ${this.name} -F "#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_top}|#{pane_left}"`,
    );
    return result
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
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
      const deadline = Date.now() + waitBudget(3000);
      while (Date.now() < deadline) {
        const state = await this._getBrowserState();
        if (state && state.activePaneId) return state.activePaneId;
        await delay(100);
      }
      return null;
    }
    return tmuxExec(`display-message -t ${this.name} -p "#{pane_id}"`);
  }

  // ==================== Window Queries ====================

  /**
   * Get current window index
   */
  async getCurrentWindowIndex() {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        const activeWin = state.windows.find((w) => w.active);
        return activeWin ? String(activeWin.index) : null;
      }
      return null;
    }
    return tmuxExec(`display-message -t ${this.name} -p "#{window_index}"`);
  }

  /**
   * Get window info (excluding float windows)
   * @param {Object} options
   * @param {boolean} options.includeFloats - Include float windows (default: false)
   */
  async getWindowInfo({ includeFloats = false } = {}) {
    if (this.page) {
      const state = await this._waitForBrowserState();
      if (state) {
        return state.windows
          .filter((w) => includeFloats || w.windowType !== 'float')
          .map((w) => ({
            id: w.id,
            index: w.index,
            name: w.name,
            active: w.active,
            windowType: w.windowType,
          }));
      }
      return [];
    }
    const result = tmuxExec(
      `list-windows -t ${this.name} -F "#{window_id}|#{window_index}|#{window_name}|#{window_active}"`,
    );
    return result
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [id, index, name, active] = line.split('|');
        return {
          id,
          index: parseInt(index, 10),
          name,
          active: active === '1',
        };
      });
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
        throw new Error(
          'tmux-capture binary not found. Run: cargo build -p tmuxy-core --bin tmux-capture',
        );
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
