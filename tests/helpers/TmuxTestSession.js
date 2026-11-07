/**
 * A test's tmux session: its lifecycle and what tmux holds for it.
 *
 * Mutations route through the tmuxy CLI (`tmuxy run ...`, i.e. `tmux
 * run-shell`): an external mutation while control mode is attached crashes
 * tmux 3.5a. Reads are read-only tmux queries, which are safe beside control
 * mode, of the tab the app shows (`window.app.view()`) once a page is set.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmuxRun, tmuxRunAsOperator } = require('./cli');
const { tmuxCmd, tmuxExec, stateDir } = require('./tmux-socket');
const { tmuxPanes, tmuxWindows } = require('./tmux-read');
const { waitForCondition, waitForSettled } = require('./browser');
const { reapPids } = require('./reap');

/**
 * The config chain the server under test built: `tmuxy.entry.conf` in the
 * suite's state dir (the defaults, the suite's own tmuxy.conf, the
 * essentials). The server rebuilds it before each use, so it is there once
 * the server answers.
 */
function getTmuxConfigPath() {
  const entry = path.join(stateDir(), 'tmuxy.entry.conf');
  return fs.existsSync(entry) ? entry : null;
}

class TmuxTestSession {
  constructor() {
    // Created by the server when a page opens it (`tmux -CC new-session`): an
    // external `tmux new-session` crashes tmux 3.5a with a control client attached.
    this.name = `tmuxy_test_${Date.now()}`;
    this.configPath = getTmuxConfigPath();
    this.page = null;
  }

  /** The page showing this session, once it has opened it. */
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

  /**
   * Run a mutating tmux command the CLI's `tmuxy run` refuses (keys into a
   * pane, a config file, an option): the harness doing what the person at the keyboard
   * would, not a path under test. See `tmuxRunAsOperator`.
   */
  runAsOperator(command) {
    return tmuxRunAsOperator(command);
  }

  /** Run a tmux command against this session (`-t <name>` appended). */
  async query(command) {
    return this.runCommand(`${command} -t ${this.name}`);
  }

  /** Source the tmuxy config into the session and move its first window to index 1. */
  async sourceConfig() {
    if (!this.configPath) {
      return;
    }

    try {
      tmuxRunAsOperator(`source-file ${this.configPath}`);
    } catch (e) {
      throw new Error(`Failed to source config ${this.configPath}: ${e.message}`);
    }

    // The config sets base-index 1, after new-session created window 0.
    try {
      this.runCommand(`move-window -s ${this.name}:0 -t ${this.name}:1`);
    } catch {
      // Already at 1.
    }

    // run-shell returns once tmux has run both commands; the test starts from
    // the state the app has seen.
    if (this.page) await waitForSettled(this.page);
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
   * pseudoterminals (see `packages/tmuxy-cli/bin/tmuxy/reap-orphan-shells`).
   */
  async destroy() {
    if (!this.exists()) return;

    let panePids = [];
    try {
      panePids = tmuxExec(`list-panes -s -t ${this.name} -F '#{pane_pid}'`)
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    } catch {
      // No session, no pids to follow up on.
    }

    try {
      this.runCommand(`kill-session -t ${this.name}`);
    } catch {
      // Already gone.
    }

    await waitForCondition(null, () => !this.exists(), 5000, `session ${this.name} to be gone`);

    reapPids(panePids);
    this.page = null;
  }

  /** Whether tmux has the session. */
  exists() {
    try {
      execSync(`${tmuxCmd()} has-session -t ${this.name} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** The tab the app shows (tmux's current one before a page is set). */
  async activeTab() {
    if (!this.page) return tmuxExec(`display-message -t ${this.name} -p "#{window_id}"`);
    return waitForCondition(
      this.page,
      () => this.page.evaluate(() => window.app?.view().activeTabId ?? null).catch(() => null),
      3000,
      'the app to show a tab',
    );
  }

  /** How many panes the tab the app shows holds. */
  async getPaneCount() {
    return (await this.getPaneInfo()).length;
  }

  /** How many tabs the session has (its chrome windows not counted). */
  async getWindowCount() {
    return (await this.getWindowInfo()).filter((w) => w.type === 'tab').length;
  }

  /** The panes of the tab the app shows, as tmux has them (`tmuxPanes`). */
  async getPaneInfo() {
    return tmuxPanes(await this.activeTab());
  }

  /** The pane the app holds active. */
  async getActivePaneId() {
    if (!this.page) return tmuxExec(`display-message -t ${this.name} -p "#{pane_id}"`);
    return waitForCondition(
      this.page,
      () => this.page.evaluate(() => window.app?.view().activePaneId ?? null).catch(() => null),
      3000,
      'the app to hold an active pane',
    );
  }

  /**
   * Wait until the session's active pane is running `command` in the
   * foreground — the moment a program started at the prompt is up and reading
   * its input, which is what a key meant for it (Ctrl+C, a line for `cat`)
   * has to wait for. Read from tmux, which knows the foreground process.
   */
  async waitForForeground(command, timeout = 10000) {
    const current = () =>
      tmuxExec(`display-message -t ${this.name} -p "#{pane_current_command}"`).trim();
    await waitForCondition(
      this.page,
      () => current() === command,
      timeout,
      () => `the active pane to run '${command}' (it runs '${current()}')`,
    );
  }

  /**
   * Wait until the line the cursor is on in the active pane matches `pattern`
   * — what the shell has made of the input so far (a completion, a recalled
   * history entry), which the whole-screen text cannot tell apart from the
   * same words printed earlier. The whole row, trailing blanks dropped: the
   * cursor's column is in cells, which a wide glyph makes no string index.
   *
   * `upToCursor` cuts the row at the cursor, for a line of narrow text: a
   * shell with autosuggestions draws a whole past command after the cursor,
   * so the row's end is not where the input ends.
   */
  async waitForCursorLine(pattern, timeout = 10000, { upToCursor = false } = {}) {
    const line = () => {
      const [x, y] = tmuxExec(`display-message -t ${this.name} -p "#{cursor_x} #{cursor_y}"`)
        .trim()
        .split(' ');
      const row = tmuxExec(`capture-pane -p -t ${this.name} -S ${y} -E ${y}`).replace(/\n$/, '');
      const text = upToCursor ? Array.from(row).slice(0, Number(x)).join('') : row;
      return text.replace(/\s+$/, '');
    };
    await waitForCondition(
      this.page,
      () => pattern.test(line()),
      timeout,
      () => `the cursor line to match ${pattern} (it reads '${line()}')`,
    );
  }

  /** The index of the tab the app shows. */
  async getCurrentWindowIndex() {
    return tmuxExec(`display-message -t ${await this.activeTab()} -p "#{window_index}"`);
  }

  /** The session's windows, floats left out, as tmux has them (`tmuxWindows`). */
  async getWindowInfo() {
    return tmuxWindows(this.name).filter((w) => w.type !== 'float');
  }
}

module.exports = TmuxTestSession;
