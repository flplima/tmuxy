/**
 * Tauri Desktop App E2E Tests
 *
 * Tests the Tauri IPC integration seam — the part that's different from the
 * web E2E tests (which use HTTP/SSE). The frontend React code is identical
 * between adapters, so we don't duplicate full UI logic coverage.
 *
 * Stack: Jest → WebdriverIO → tauri-driver (port 4444) → WebKitWebDriver → Tauri app
 *
 * Each test creates a fresh WDIO session (launching a new Tauri binary instance)
 * with a unique TMUXY_SESSION name for isolation.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTauriTestContext,
  getTerminalText,
  getAppState,
  getPaneCount,
  invokeCommand,
  waitForRawWindowCount,
} = require('./helpers/wdio-client');
const { tmuxCmd, tmuxExec } = require('../helpers/tmux-socket');

const ctx = createTauriTestContext();
let driver = null;
let sessionName = null;

afterEach(async () => {
  await ctx.afterEachHook();
  driver = null;
  sessionName = null;
});

/**
 * Helper: create a session and wait for app to be ready
 */
async function setupApp(options = {}) {
  const result = await ctx.setupApp(options);
  driver = result.driver;
  sessionName = result.sessionName;
  return result;
}

// ==================== App Lifecycle ====================

describe('App Lifecycle', () => {
  test('launching the app shows a terminal of real size, on the Tauri adapter, over its own tmux session', async () => {
    await setupApp();

    // The terminal is on screen with an area a user could read, not a
    // zero-height strip clipped by a parent.
    const terminal = await driver.$('[role="log"]');
    expect(await terminal.isDisplayed()).toBe(true);
    const measure = () =>
      driver.execute(() => {
        // The first [role="log"] in the DOM is not necessarily one on screen —
        // a pane in a background tab and a closed sidebar keep theirs mounted.
        // Take the largest visible area across all of them: "the app launched
        // showing a terminal" is a claim about what is on the screen.
        let best = null;
        for (const log of document.querySelectorAll('[role="log"]')) {
          const r = log.getBoundingClientRect();
          const visibleWidth = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
          const visibleHeight = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
          const area = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
          if (!best || area > best.area) {
            best = { width: r.width, height: r.height, visibleWidth, visibleHeight, area };
          }
        }
        return best;
      });
    // The window lays out over the first frames after launch: a terminal can
    // still be sized but parked below the viewport when the app has just
    // opened. Wait for one to be on screen rather than sampling once.
    let rect = await measure();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(rect && rect.area > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      rect = await measure();
    }
    expect(rect).not.toBeNull();
    expect(rect.width).toBeGreaterThan(200);
    expect(rect.height).toBeGreaterThan(100);
    expect(rect.visibleWidth).toBeGreaterThan(200);
    expect(rect.visibleHeight).toBeGreaterThan(100);

    // The shell prompt rendered into it.
    const text = await getTerminalText(driver);
    expect(text.length).toBeGreaterThan(0);

    // The desktop build talks IPC, not HTTP/SSE, and names its session after
    // TMUXY_SESSION (default `tmuxy`).
    const state = await getAppState(driver);
    expect(state).not.toBeNull();
    expect(state.adapterType).toBe('tauri');
    expect(state.sessionName).toBe(sessionName);

    // The session the app reports really exists in tmux.
    try {
      tmuxExec(`has-session -t ${sessionName}`);
    } catch {
      throw new Error(`tmux session '${sessionName}' not found`);
    }
  });
});

// ==================== State Sync ====================

describe('State Sync', () => {
  test('keybindings are available via IPC', async () => {
    await setupApp();

    // The snapshot the monitor keeps of its last `tmux-keybindings` emit (the
    // event may arrive before the frontend listener is set up, so the
    // broadcast alone is not enough). It is taken once the config is sourced.
    let bindings = null;
    const deadline = Date.now() + 15000;
    while (!bindings && Date.now() < deadline) {
      bindings = await invokeCommand(driver, 'get_keybindings_snapshot');
      if (!bindings) await driver.pause(200);
    }
    expect(bindings).toBeTruthy();
    expect(bindings.prefix_key).toBeTruthy();
    expect(Array.isArray(bindings.prefix_bindings)).toBe(true);
  });

  // The left column is created by one command list: split-window, break-pane,
  // set-option. This transport used to give every command that named no target
  // a `-t <session>`, and break-pane's `-t` is where the pane should GO, not
  // what to act on. The injected destination resolved to the session's current
  // window, whose index is by definition taken, so tmux answered "index in use",
  // the break failed, and the tree stayed behind as an ordinary pane in the tab
  // instead of becoming the sidebar. Only this suite can see it: the web server
  // sends the same list down the control-mode connection with no rewrite.
  test('opening the left sidebar makes its own window and leaves no pane behind', async () => {
    await setupApp();

    const panesBefore = await getPaneCount(driver);

    // The path the toggle button and `prefix t` both take.
    await driver.execute(() => window.app.send({ type: 'TOGGLE_LEFT_SIDEBAR' }));

    let names = '';
    for (let i = 0; i < 60; i++) {
      names = tmuxExec(`list-windows -t ${sessionName} -F '#{window_name}'`);
      if (names.includes('__sidebar-left')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(names).toContain('__sidebar-left');

    // The tab the user was looking at is untouched: the tree went into the
    // sidebar window, it did not stay behind as a pane here.
    expect(await getPaneCount(driver)).toBe(panesBefore);
  });

  // The desktop app serves no HTTP: a theme the user copied into the config
  // dir reaches the webview through the `tmuxycss:` scheme, or not at all —
  // the bundled frontend only carries the built-in themes, and picking a
  // custom one used to 404 and leave the page in the browser's defaults.
  test('a theme copied into the config dir is listed with its modes and served to the webview', async () => {
    const themes = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'tmuxy',
      'themes',
    );
    fs.mkdirSync(themes, { recursive: true });
    const mine = path.join(themes, 'e2e-tauri.css');
    fs.writeFileSync(mine, ':root.theme-dark {\n  --term-background: #123456;\n}\n');
    try {
      await setupApp();

      const listed = await invokeCommand(driver, 'get_themes_list');
      expect(listed.find((t) => t.name === 'e2e-tauri')).toEqual({
        name: 'e2e-tauri',
        displayName: 'E2e Tauri',
        modes: ['dark'],
      });

      // Picked the way the Theme menu picks it; the page resolves the file's
      // own value once the scheme has served it.
      await driver.execute(() => window.app.send({ type: 'SET_THEME', name: 'e2e-tauri' }));
      let resolved = '';
      for (let i = 0; i < 40 && resolved !== '#123456'; i++) {
        resolved = await driver.execute(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--term-background').trim(),
        );
        if (resolved !== '#123456') await driver.pause(250);
      }
      expect(resolved).toBe('#123456');
      const href = await driver.execute(
        () => document.getElementById('tmuxy-theme')?.getAttribute('href') ?? null,
      );
      expect(href).toContain('tmuxycss');
      expect(href).toContain('/themes/e2e-tauri.css');
    } finally {
      // The pick was persisted for the next launch: put the default back.
      if (driver) {
        await driver.execute(() => window.app.send({ type: 'SET_THEME', name: 'default' }));
      }
      fs.rmSync(mine, { force: true });
    }
  });
});

// ==================== GUI windows over one session ====================

describe('GUI windows', () => {
  /**
   * The Window menu's own commands. Two OS windows on one tmux session are two
   * clients on two sessions in one session group: they share every tab and pane
   * and each keeps its own current tab, which is the whole point — one window can
   * show one tab while the other shows a different one.
   */
  test('New Window opens a second client in the session group, with its own current tab', async () => {
    await setupApp();

    // A second tab to have somewhere to diverge to.
    await invokeCommand(driver, 'run_tmux_command', { command: 'new-window' });
    await waitForRawWindowCount(driver, 2);

    const before = await invokeCommand(driver, 'list_gui_windows');
    expect(before).toHaveLength(1);
    expect(before[0].index).toBe(1);

    await invokeCommand(driver, 'new_window');

    // The registry knows both windows, and the digit that focuses each.
    let listed = [];
    for (let i = 0; i < 60; i++) {
      listed = await invokeCommand(driver, 'list_gui_windows');
      if (listed.length === 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(listed.map((w) => w.index)).toEqual([1, 2]);

    // tmux's side of it: a second session, grouped with the first, so the
    // windows are shared rather than copied.
    const grouped = `${sessionName}~2`;
    let sessions = '';
    for (let i = 0; i < 60; i++) {
      sessions = tmuxExec("list-sessions -F '#{session_name} #{session_group} #{session_windows}'");
      if (sessions.includes(grouped)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const rows = sessions.split('\n').filter((r) => r.trim().length > 0);
    const base = rows.find((r) => r.startsWith(`${sessionName} `));
    const second = rows.find((r) => r.startsWith(`${grouped} `));
    expect(second).toBeDefined();
    // Same group, and the same number of windows — shared, not duplicated.
    expect(second.split(' ')[1]).toBe(base.split(' ')[1]);
    expect(second.split(' ')[2]).toBe(base.split(' ')[2]);

    // Each client has its own current window: moving THIS window's client
    // leaves the other where it was, which is what a session group buys and what
    // two clients on one session could never do. The move goes through this
    // window's own control-mode connection — an external tmux mutation while a
    // control client is attached can crash tmux 3.5a.
    const indexes = tmuxExec(`list-windows -t ${sessionName} -F '#{window_index}'`)
      .split('\n')
      .map((i) => i.trim())
      .filter((i) => i.length > 0);
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    const currentOf = (session) =>
      tmuxExec(`display-message -p -t ${session} '#{window_index}'`).trim();
    const otherBefore = currentOf(grouped);

    const target = indexes.find((i) => i !== otherBefore);
    await invokeCommand(driver, 'run_tmux_command', {
      command: `select-window -t ${sessionName}:${target}`,
    });

    let mine = otherBefore;
    for (let i = 0; i < 60; i++) {
      mine = currentOf(sessionName);
      if (mine === target) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(mine).toBe(target);
    // The second window did not follow.
    expect(currentOf(grouped)).toBe(otherBefore);

    // Cleaning up after itself: the grouped session is the second window's, and
    // the suite's teardown only knows about the base one.
    execSync(`${tmuxCmd()} kill-session -t ${grouped}`, { stdio: 'ignore' });
  }, 180000);

  test('a window style is applied and reported back', async () => {
    await setupApp();

    expect(await invokeCommand(driver, 'get_window_style')).toBe('normal');

    // A docked style: the window keeps its height and spans the work area, which
    // is iTerm2's "Full-Width Top of Screen".
    await invokeCommand(driver, 'set_window_style', { style: 'full-width-top' });
    expect(await invokeCommand(driver, 'get_window_style')).toBe('full-width-top');

    // Normal puts back the frame the window had before it was styled.
    await invokeCommand(driver, 'set_window_style', { style: 'normal' });
    expect(await invokeCommand(driver, 'get_window_style')).toBe('normal');

    // No Title Bar and back, also out of full screen and out of a maximized
    // frame: after each Normal the page is as tall as it was before the cycle
    // (the content view is still full-size — rewriting the decorations used to
    // put a real title-bar strip above the page on macOS and cost it that
    // height; `outerHeight` is 0 in WebKit, so the page's own height is the
    // measure) and the room the status bar keeps for the traffic lights is
    // back; with no title bar the room is gone. The chrome itself is macOS's:
    // elsewhere (CI runs this suite under Xvfb) only the reported style is
    // asserted.
    const chrome = () =>
      driver.execute(() => ({
        inner: window.innerHeight,
        spacer: document.querySelector('.traffic-light-spacer')?.getBoundingClientRect().width ?? 0,
      }));
    const before = await chrome();
    const settled = async (style) => {
      // Full screen enters and leaves with an animation; the style lands after it.
      for (let i = 0; i < 40; i++) {
        if ((await invokeCommand(driver, 'get_window_style')) === style) break;
        await driver.pause(250);
      }
      await driver.pause(style === 'full-screen' ? 2000 : 500);
      expect(await invokeCommand(driver, 'get_window_style')).toBe(style);
    };
    for (const cycle of [
      ['no-title-bar', 'normal'],
      ['full-screen', 'no-title-bar', 'normal'],
      ['full-width-top', 'no-title-bar', 'maximized', 'normal'],
    ]) {
      for (const style of cycle) {
        await invokeCommand(driver, 'set_window_style', { style });
        await settled(style);
        if (process.platform !== 'darwin') continue;
        const seen = await chrome();
        if (style === 'no-title-bar') {
          expect(seen.spacer).toBe(0);
        }
        if (style === 'normal') {
          expect(seen.inner).toBe(before.inner);
          expect(seen.spacer).toBe(before.spacer);
        }
      }
    }

    // A style nobody defines is refused rather than silently ignored.
    //
    // The refusal arrives as `{ __error }`, not as a rejected promise:
    // `invokeCommand` catches what `invoke()` throws and resolves with it, so
    // it never rejects and `.rejects` could not pass whatever the app did.
    const refused = await invokeCommand(driver, 'set_window_style', { style: 'sideways' });
    expect(refused.__error).toMatch(/unknown window style/i);
    expect(refused.__kind).toBe('invalid');
  }, 120000);

  // The menus are the page's: one spec per surface, and on macOS the menu bar
  // is set from it. A WebDriver cannot click a native menu, so the suite tests
  // the seam — the bar's spec holds the app's items in their places, and the
  // platform takes the menu (macOS; Linux has no menu bar to set).
  test('the native menu bar is built from the menu spec and the platform takes it', async () => {
    await setupApp();

    let ids = [];
    for (let i = 0; i < 40 && ids.length === 0; i++) {
      ids = await driver.execute(() => window.tmuxyMenus?.barIds() ?? []);
      if (ids.length === 0) await driver.pause(250);
    }
    expect(ids).toEqual(
      expect.arrayContaining([
        'menu-app',
        'session-reload-config',
        'restart-app',
        'menu-pane',
        'pane-split-below',
        'tab-overview',
        'tab-stack-toggle',
        'window-close',
        'trace-enabled',
        'help-about',
      ]),
    );
    // A context menu is about its thing: nothing of the app section in the
    // pane menu, and nothing twice in the bar.
    expect(new Set(ids).size).toBe(ids.length);

    if (process.platform === 'darwin') {
      const set = await driver.executeAsync((done) => {
        window.tmuxyMenus
          .rebuild()
          .then((ok) => done(ok))
          .catch((e) => done(`error: ${e?.message ?? e}`));
      });
      expect(set).toBe(true);
    }
  }, 120000);
});
