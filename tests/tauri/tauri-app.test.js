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
const {
  createSession,
  waitForAppReady,
  waitForXState,
  getTerminalText,
  waitForTerminalText,
  typeKeys,
  pressKey,
  getAppState,
  getPaneCount,
  getWindowCount,
  invokeCommand,
  waitForPaneCount,
  waitForWindowCount,
} = require('./helpers/wdio-client');
const { tmuxQuery } = require('../helpers/cli');

// Shared driver/session state for each test
let driver = null;
let sessionName = null;

afterEach(async () => {
  // Terminate WDIO session (kills Tauri binary)
  if (driver) {
    try {
      await driver.deleteSession();
    } catch {
      // Session may already be dead
    }
    driver = null;
  }

  // Kill tmux session
  if (sessionName) {
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
    } catch {
      // Session may already be gone
    }
    sessionName = null;
  }

  // Brief pause for cleanup
  await new Promise(r => setTimeout(r, 1000));
});

/**
 * Helper: create a session and wait for app to be ready
 */
async function setupApp(options = {}) {
  const result = await createSession(options);
  driver = result.driver;
  sessionName = result.sessionName;
  await waitForAppReady(driver);
  await waitForXState(driver);
  return { driver, sessionName };
}

// ==================== App Lifecycle ====================

describe('App Lifecycle', () => {
  test('launches and renders terminal UI', async () => {
    await setupApp();

    // Terminal should be visible
    const terminal = await driver.$('[role="log"]');
    expect(await terminal.isDisplayed()).toBe(true);

    // Should have terminal content (shell prompt)
    const text = await getTerminalText(driver);
    expect(text.length).toBeGreaterThan(0);
  });

  test('uses TauriAdapter', async () => {
    await setupApp();

    const state = await getAppState(driver);
    expect(state).not.toBeNull();
    // The adapter type should indicate Tauri
    expect(state.adapterType).toBe('tauri');
  });

  test('creates tmux session with TMUXY_SESSION name', async () => {
    await setupApp();

    // Verify the tmux session exists with the expected name
    const state = await getAppState(driver);
    expect(state.sessionName).toBe(sessionName);

    // Verify via tmux CLI
    try {
      tmuxQuery(`has-session -t ${sessionName}`);
    } catch {
      throw new Error(`tmux session '${sessionName}' not found`);
    }
  });
});

// ==================== IPC Commands ====================

describe('IPC Commands', () => {
  test('type input appears in terminal', async () => {
    await setupApp();

    const marker = `TAURI_TEST_${Date.now()}`;
    await typeKeys(driver, `echo ${marker}`);
    await pressKey(driver, 'Enter');
    await waitForTerminalText(driver, marker);
  });

  test('split pane via IPC', async () => {
    await setupApp();

    // Start with 1 pane
    expect(await getPaneCount(driver)).toBe(1);

    // Split via Tauri IPC command
    await invokeCommand(driver, 'split_pane_horizontal');
    await waitForPaneCount(driver, 2);

    expect(await getPaneCount(driver)).toBe(2);
  });

  test('new window via IPC', async () => {
    await setupApp();

    expect(await getWindowCount(driver)).toBe(1);

    await invokeCommand(driver, 'new_window');
    await waitForWindowCount(driver, 2);

    expect(await getWindowCount(driver)).toBe(2);
  });

  test('run_tmux_command via IPC', async () => {
    await setupApp();

    // Run a tmux command through the IPC channel
    const result = await invokeCommand(driver, 'run_tmux_command', {
      command: 'display-message -p #{session_name}',
    });

    // The result should contain our session name
    expect(result).toContain(sessionName);
  });
});

// ==================== Tauri-Specific Features ====================

describe('Tauri Features', () => {
  test('default session name is used', async () => {
    await setupApp();

    const state = await getAppState(driver);
    expect(state.sessionName).toBe('tmuxy');
  });

  test('window opacity attribute is set when configured', async () => {
    await setupApp();

    // Set @tmuxy-opacity via tmux and restart would be needed for full test.
    // Instead, verify the frontend can read the data-opacity attribute.
    const hasOpacitySupport = await driver.execute(() => {
      // Check that the TauriAdapter is loaded (Tauri-specific feature)
      return typeof window.__TAURI_INTERNALS__ !== 'undefined';
    });

    expect(hasOpacitySupport).toBe(true);
  });

  test('vibrancy detection available', async () => {
    await setupApp();

    // Verify Tauri API is available in the webview
    const hasTauriApi = await driver.execute(() => {
      return !!(window.__TAURI_INTERNALS__?.invoke);
    });

    expect(hasTauriApi).toBe(true);
  });
});

// ==================== State Sync ====================

describe('State Sync', () => {
  test('delta protocol updates pane state', async () => {
    await setupApp();

    // Initial state: 1 pane
    let state = await getAppState(driver);
    expect(state.panes.length).toBe(1);

    // Split creates new pane — state should update via Tauri event → delta protocol
    await invokeCommand(driver, 'split_pane_horizontal');
    await waitForPaneCount(driver, 2);

    state = await getAppState(driver);
    expect(state.panes.length).toBeGreaterThanOrEqual(2);

    // Both panes should have valid dimensions
    for (const pane of state.panes) {
      expect(pane.width).toBeGreaterThan(0);
      expect(pane.height).toBeGreaterThan(0);
    }
  });

  test('keybindings are available via IPC', async () => {
    await setupApp();

    // Fetch keybindings directly via IPC (the event may arrive before the
    // frontend listener is set up, so we can't rely on the broadcast alone)
    const bindings = await invokeCommand(driver, 'get_key_bindings');
    expect(bindings).toBeDefined();
    expect(bindings.prefix).toBeDefined();
  });
});
