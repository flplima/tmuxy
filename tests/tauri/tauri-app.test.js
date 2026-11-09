/**
 * The desktop app's IPC seam — what differs from the web build's HTTP/SSE.
 * The React code is the same in both, so the UI's own behaviour is the web
 * suites'.
 *
 * Stack: Jest → WebdriverIO → tauri-driver (port 4444) → WebKitWebDriver → Tauri app.
 * Each test launches a fresh app on a fresh tmux session.
 */

const fs = require('fs');
const path = require('path');
const {
  createTauriTestContext,
  getTerminalText,
  getAppState,
  getPaneCount,
  invokeCommand,
} = require('./helpers/wdio-client');
const { tmuxEnv, tmuxExec } = require('../helpers/tmux-socket');
const { waitForCondition } = require('../helpers/browser');

const ctx = createTauriTestContext();
let driver = null;
let sessionName = null;

afterEach(async () => {
  await ctx.afterEachHook();
  driver = null;
  sessionName = null;
});

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
    let rect = null;
    await waitForCondition(
      null,
      async () => (rect = await measure())?.area > 0,
      10000,
      async () => `a terminal on screen (the largest: ${JSON.stringify(rect)})`,
    );
    expect(rect.width).toBeGreaterThan(200);
    expect(rect.height).toBeGreaterThan(100);
    expect(rect.visibleWidth).toBeGreaterThan(200);
    expect(rect.visibleHeight).toBeGreaterThan(100);

    // Text is drawn in it.
    const text = await getTerminalText(driver);
    expect(text.length).toBeGreaterThan(0);

    // The desktop build talks IPC, not HTTP/SSE, and names its session after
    // TMUXY_SESSION (default `tmuxy`).
    const state = await getAppState(driver);
    expect(state).not.toBeNull();
    expect(state.adapterType).toBe('tauri');
    expect(state.sessionName).toBe(sessionName);

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

    // The greeting carries the bindings the monitor last read (the event
    // may arrive before the frontend listener is set up, so the broadcast
    // alone is not enough). They are read once the config is sourced.
    let bindings = null;
    const deadline = Date.now() + 15000;
    while (!bindings && Date.now() < deadline) {
      const greeting = await invokeCommand(driver, 'greeting');
      bindings = greeting?.find?.((e) => e.event === 'keybindings')?.data ?? null;
      if (!bindings) await driver.pause(200);
    }
    expect(bindings).toBeTruthy();
    expect(bindings.prefix_key).toBeTruthy();
    expect(Array.isArray(bindings.prefix_bindings)).toBe(true);
  });

  // The left column is created by one command list: split-window, break-pane,
  // set-option. break-pane's `-t` is where the pane should GO, so a transport
  // that adds `-t <session>` to every untargeted command (this one once did)
  // aims it at the current window, whose index is taken: tmux answers "index
  // in use" and the tree stays behind as a pane in the tab. Only this suite
  // can see it: the web server sends the list with no rewrite.
  test('opening the left sidebar makes its own window and leaves no pane behind', async () => {
    await setupApp();

    const panesBefore = await getPaneCount(driver);

    // The path the toggle button and `prefix t` both take.
    await driver.execute(() => window.app.send({ type: 'TOGGLE_SIDEBAR', side: 'left' }));

    const names = () => tmuxExec(`list-windows -t ${sessionName} -F '#{window_name}'`);
    await waitForCondition(
      null,
      () => names().includes('__sidebar-left'),
      30000,
      () => `the sidebar window (tmux has: ${names()})`,
    );

    // The tab the user was looking at is untouched: the tree went into the
    // sidebar window, it did not stay behind as a pane here.
    expect(await getPaneCount(driver)).toBe(panesBefore);
  });

  // The desktop app serves no HTTP: a theme the user copied into the config
  // dir reaches the webview through the `tmuxycss:` scheme, or not at all —
  // the bundled frontend only carries the built-in themes.
  test('a theme copied into the config dir is listed with its modes and served to the webview', async () => {
    // The config dir the app is started with (`driverEnv`), the suite's own.
    const themes = path.join(tmuxEnv().XDG_CONFIG_HOME, 'tmuxy', 'themes');
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
      const resolved = () =>
        driver.execute(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--term-background').trim(),
        );
      await waitForCondition(
        null,
        async () => (await resolved()) === '#123456',
        10000,
        async () => `the theme's background (it resolves to '${await resolved()}')`,
      );
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
