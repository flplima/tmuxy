/**
 * The Tauri suites' helpers, over WebdriverIO's `remote()`: the web E2E
 * helpers' shapes on `driver.execute` and `driver.keys`.
 */

const { remote } = require('webdriverio');
const { execFileSync, execSync } = require('child_process');
const path = require('path');
const { DRIVER_PORT } = require('./tauri-driver');
const { tmuxCmd, tmuxEnv } = require('../../helpers/tmux-socket');
const { tauriBinary } = require('../../helpers/config');

// CI builds the release binary once and drives both the smoke test and this
// suite against it (`$TAURI_BINARY`), the binary users actually launch.
const TAURI_BINARY = tauriBinary();

// WebDriver Unicode key codes for special keys.
//
// Order matters and is easy to misread — the arrows sit immediately after
// Home/End in a contiguous block:
//   E00E PageUp  E00F PageDown  E010 End    E011 Home
//   E012 Left    E013 Up        E014 Right  E015 Down
const KEYS = {
  Enter: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  ArrowUp: '\uE013',
  ArrowDown: '\uE015',
  ArrowLeft: '\uE012',
  ArrowRight: '\uE014',
  Control: '\uE009',
  Shift: '\uE008',
  Alt: '\uE00A',
  Meta: '\uE03D',
};

/**
 * Run tmux on the suite's socket, in the suite's environment: a tmux server
 * this starts is born with it, and every pane's shell inherits it. Throws when
 * tmux fails; prints nothing.
 */
function tmux(args) {
  execSync(`${tmuxCmd()} ${args}`, { stdio: 'ignore', env: tmuxEnv() });
}

/** Kill the tmux session `sessionName` on the suite's socket, if it exists. */
function killTmuxSession(sessionName) {
  try {
    tmux(`kill-session -t ${sessionName}`);
  } catch {
    // Not there is the state wanted.
  }
}

/**
 * Launch the app through the WebDriver on {@link DRIVER_PORT} — tauri-driver
 * on Linux, tauri-webdriver on macOS — and return the session driving it.
 *
 * @param {string} [binary] - the app to launch (default: {@link TAURI_BINARY})
 * @param {number} [port] - the driver to launch it through (default: {@link DRIVER_PORT})
 * @returns {Promise<WebdriverIO.Browser>}
 */
async function launchApp(binary = TAURI_BINARY, port = DRIVER_PORT) {
  return remote({
    hostname: 'localhost',
    port,
    capabilities: {
      'tauri:options': {
        application: binary,
        env: {
          DISPLAY: process.env.DISPLAY || ':99',
        },
      },
    },
    logLevel: 'warn',
    // Creating the session launches the app and waits for its webview to
    // register as an automation target: ~26s on the Linux CI runners (the
    // app is silent for ~25s between GTK init and its first log line), so a
    // 30s cap turned the job red on any extra startup cost. Callers print the
    // elapsed time so the margin stays visible in the log.
    connectionRetryTimeout: 120000,
    // No retries: WebKitWebDriver serves one session at a time, so a second
    // attempt after a timeout fails with "Maximum number of active
    // sessions" and reports that instead of the timeout that caused it.
    connectionRetryCount: 0,
  });
}

/**
 * Launch a fresh app on a fresh tmux session.
 *
 * @param {Object} options
 * @param {string} [options.sessionName] - TMUXY_SESSION name (default: auto-generated)
 * @returns {Promise<{driver: WebdriverIO.Browser, sessionName: string}>}
 */
async function createSession(options = {}) {
  // tauri-driver does not forward `tauri:options.env` to the binary, so the
  // app takes TMUXY_SESSION from tauri-driver's own environment, else
  // "tmuxy"; each test kills and re-creates that session instead.
  const sessionName = options.sessionName || 'tmuxy';

  // Pre-create the tmux session. The Tauri binary's built-in session creation
  // can fail when the tmuxy config contains settings (like `window-size manual`)
  // that crash tmux on a fresh start without an attached client.
  killTmuxSession(sessionName);
  try {
    tmux(`new-session -d -s ${sessionName}`);
  } catch {
    // Already there is fine.
  }

  const driver = await launchApp();

  return { driver, sessionName };
}

/**
 * Wait for a terminal showing a shell prompt.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} timeout - Max wait time in ms
 */
async function waitForAppReady(driver, timeout = 30000) {
  const terminal = await driver.$('[role="log"]');
  await terminal.waitForExist({ timeout });

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hasContent = await driver.execute(() => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs)
        .map((l) => l.textContent || '')
        .join('\n');
      return content.length > 5 && /[$#%>❯]/.test(content);
    });
    if (hasContent) return;
    await driver.pause(200);
  }
  throw new Error(`App not ready within ${timeout}ms`);
}

/**
 * Wait for `window.app` to be published.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} timeout
 */
async function waitForXState(driver, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await driver.execute(() => {
      return !!window.app?.getSnapshot;
    });
    if (ready) return;
    await driver.pause(200);
  }
  throw new Error(`window.app not available within ${timeout}ms`);
}

/**
 * The text of every `[role="log"]`, joined.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<string>}
 */
async function getTerminalText(driver) {
  return driver.execute(() => {
    const logs = document.querySelectorAll('[role="log"]');
    return Array.from(logs)
      .map((l) => l.textContent || '')
      .join('\n');
  });
}

/**
 * Wait for specific text to appear in the terminal, `times` times over — two
 * for a command that echoes its own argument: once as typed, once as output.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} text
 * @param {number} timeout
 * @param {number} times
 */
async function waitForTerminalText(driver, text, timeout = 15000, times = 1) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const content = await getTerminalText(driver);
    if (content.split(text).length - 1 >= times) return content;
    await driver.pause(200);
  }
  const content = await getTerminalText(driver);
  throw new Error(
    `Timeout waiting for "${text}" in terminal (${timeout}ms, ${times}x). Content: "${content.slice(0, 500)}"`,
  );
}

/**
 * Click the terminal and type `text` into it, a key at a time.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} text
 */
async function typeKeys(driver, text) {
  const terminal = await driver.$('[role="log"]');
  if (await terminal.isExisting()) {
    await terminal.click();
    await driver.pause(100);
  }

  for (const char of text) {
    await driver.keys(char);
    await driver.pause(30);
  }
}

/**
 * Press a special key (Enter, Escape, etc.).
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} key - Key name from KEYS map
 */
async function pressKey(driver, key) {
  const code = KEYS[key];
  if (!code) throw new Error(`Unknown key: ${key}. Available: ${Object.keys(KEYS).join(', ')}`);
  await driver.keys([code]);
  await driver.pause(100);
}

/**
 * The parts of the app's machine context the Tauri suites check.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<Object|null>}
 */
async function getAppState(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const ctx = snap.context;
    return {
      sessionName: ctx.sessionName,
      adapterType: '__TAURI_INTERNALS__' in window ? 'tauri' : 'http',
      panes: ctx.panes?.map((p) => ({
        id: p.tmuxId,
        windowId: p.windowId,
        active: p.active,
        width: p.width,
        height: p.height,
      })),
      windows: ctx.windows?.map((w) => ({
        id: w.id,
        index: w.index,
        name: w.name,
        active: w.active,
      })),
      activeWindowId: ctx.activeWindowId,
      activePaneId: ctx.activePaneId,
      keybindings: ctx.keybindings,
    };
  });
}

/**
 * How many panes the app holds in its active window.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<number>}
 */
async function getPaneCount(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return 0;
    const ctx = snap.context;
    return ctx.panes?.filter((p) => p.windowId === ctx.activeWindowId).length || 0;
  });
}

/**
 * Get the total number of windows the app knows about, regardless of
 * `@tmuxy-window-type` classification.
 *
 * A newly created window's row lands in `ctx.windows` as soon as the monitor
 * reports it, but its `windowType=tab` tag is stamped asynchronously by the
 * executor subprocess after `splitw ; breakp` and, under CI's tmux 3.4, can
 * lag indefinitely. This raw count converges immediately on creation, so it's
 * the reliable signal for "a window was created" — use it when the test cares
 * that a window appeared, not how it was classified.
 *
 * @param {WebdriverIO.Browser} driver
 * @returns {Promise<number>}
 */
async function getRawWindowCount(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return 0;
    return snap.context.windows?.length || 0;
  });
}

/** Snapshot of every window with its classification, for failure diagnostics. */
async function dumpWindows(driver) {
  return driver.execute(() => {
    const snap = window.app?.getSnapshot();
    return (snap?.context?.windows || []).map((w) => ({
      id: w.id,
      index: w.index,
      name: w.name,
      windowType: w.windowType,
    }));
  });
}

/**
 * Run a client command (e.g. 'run_tmux_command') the way the page's adapter
 * does: through the desktop's one `dispatch` IPC command, as `{ cmd, args }`.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} command - The client command's wire name
 * @param {Object} args - Command arguments
 * @returns {Promise<*>}
 */
async function invokeCommand(driver, command, args = {}) {
  return invokeIpc(driver, 'dispatch', { request: { cmd: command, args } });
}

/**
 * Invoke one of the desktop's window-chrome IPC commands (`new_window`,
 * `list_gui_windows`, `get_window_style`, …) directly.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {string} command - The IPC command's name
 * @param {Object} args - Command arguments
 * @returns {Promise<*>}
 */
async function invokeWindowCommand(driver, command, args = {}) {
  return invokeIpc(driver, command, args);
}

async function invokeIpc(driver, command, args) {
  // Use executeAsync because Tauri invoke() returns a Promise, and the WebDriver
  // execute/sync endpoint doesn't support async functions in WebKitWebDriver.
  return driver.executeAsync(
    (cmd, a, done) => {
      window.__TAURI_INTERNALS__
        ?.invoke(cmd, a)
        .then((result) => {
          if (result == null) return done(null);
          // Control characters break WebDriver JSON; newlines and tabs stay,
          // since a `query_tmux` listing is one row per line.
          if (typeof result === 'string') {
            return done(result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
          }
          done(JSON.parse(JSON.stringify(result)));
        })
        // A command refuses with `{ error, kind }`; an exception has `message`.
        .catch((e) =>
          done({ __error: e?.error || e?.message || String(e), __kind: e?.kind ?? null }),
        );
    },
    command,
    args,
  );
}

/**
 * Wait for the app's active window to hold `expected` panes.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} expected
 * @param {number} timeout
 */
async function waitForPaneCount(driver, expected, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getPaneCount(driver);
    if (count === expected) return;
    await driver.pause(200);
  }
  const actual = await getPaneCount(driver);
  throw new Error(`Expected ${expected} panes, got ${actual} (timeout ${timeout}ms)`);
}

/**
 * Wait for the total number of app-known windows to reach the expected value,
 * regardless of `@tmuxy-window-type` classification. See
 * {@link getRawWindowCount} for why this is the reliable "window created"
 * signal. Default 20s: the row appears as soon as the monitor reports it.
 *
 * @param {WebdriverIO.Browser} driver
 * @param {number} expected
 * @param {number} timeout
 */
async function waitForRawWindowCount(driver, expected, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await getRawWindowCount(driver);
    if (count === expected) return;
    await driver.pause(200);
  }
  const actual = await getRawWindowCount(driver);
  const windows = JSON.stringify(await dumpWindows(driver));
  throw new Error(
    `Expected ${expected} windows, got ${actual} (timeout ${timeout}ms). Windows: ${windows}`,
  );
}

/** Poll `condition` until it holds; throw with `what` past `timeout` ms. */
async function waitUntil(condition, timeout, what) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what} (${timeout}ms)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The Tauri suites' per-test lifecycle: launch the app, and tear its
 * WebDriver session and tmux session down after each test.
 */
function createTauriTestContext() {
  const state = { driver: null, sessionName: null };

  async function setupApp(options = {}) {
    const result = await createSession(options);
    state.driver = result.driver;
    state.sessionName = result.sessionName;
    await waitForAppReady(state.driver);
    await waitForXState(state.driver);
    return { driver: state.driver, sessionName: state.sessionName };
  }

  async function afterEachHook() {
    if (state.driver) {
      try {
        await state.driver.deleteSession();
      } catch {
        // Already gone.
      }
      state.driver = null;
    }

    // Wait until the session is gone, not just killed: every test reuses the
    // name, and a next app that attaches to the dying one reads a stale
    // multi-pane baseline, then collapses to a fresh 1-pane session mid-test.
    if (state.sessionName) {
      const target = state.sessionName;
      const gone = () => {
        try {
          tmux(`has-session -t ${target}`);
          return false;
        } catch {
          return true;
        }
      };
      try {
        tmux(`kill-session -t ${target}`);
      } catch {
        // Already gone.
      }
      await waitUntil(gone, 5000, `tmux session ${target} to be gone`);
      state.sessionName = null;
    }

    // The next test launches the app again; one still exiting holds its
    // window and its control-mode client. A process running the binary, by
    // its program word: `pgrep -f` through a shell also matched that shell,
    // whose command line names the binary, so the app never read as gone.
    const appRunning = () =>
      execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
        .split('\n')
        .some((args) => args.trim().split(' ')[0] === TAURI_BINARY);
    await waitUntil(() => !appRunning(), 10000, `the app (${TAURI_BINARY}) to exit`);
  }

  return { state, setupApp, afterEachHook };
}

module.exports = {
  createTauriTestContext,
  killTmuxSession,
  launchApp,
  waitForAppReady,
  waitForXState,
  getTerminalText,
  waitForTerminalText,
  typeKeys,
  pressKey,
  getAppState,
  getPaneCount,
  invokeCommand,
  invokeWindowCommand,
  waitForPaneCount,
  waitForRawWindowCount,
};
