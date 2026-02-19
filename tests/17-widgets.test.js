/**
 * Category 17: Widgets
 *
 * Tests the widget system: panes that print the __TMUXY_WIDGET__ marker
 * render a custom React component instead of the Terminal.
 *
 * Session creation: tmux 3.5a crashes on external `new-session` when control
 * mode is attached. We create test sessions through control mode via a helper
 * page connected to the default tmuxy session.
 */

const {
  createTestContext,
  delay,
  waitForTerminalText,
  navigateToSession,
  waitForSessionReady,
  focusPage,
  TmuxTestSession,
  DELAYS,
  TMUXY_URL,
} = require('./helpers');

// 1x1 red PNG, base64-encoded
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// 1x1 blue PNG, base64-encoded
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

// 1x1 green PNG, base64-encoded
const GREEN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Send a command to the pane via tmux send-keys (no Terminal text wait) */
function sendCommand(session, command) {
  session.runCommand(`send-keys -t ${session.name} -l '${command.replace(/'/g, "'\"'\"'")}'`);
  session.runCommand(`send-keys -t ${session.name} Enter`);
}

/** Wait for a CSS selector to appear in the page */
function waitForSelector(page, selector, timeout = 10000) {
  return page.waitForFunction(
    (sel) => document.querySelector(sel) !== null,
    selector,
    { timeout, polling: 200 }
  );
}

/**
 * Create a tmux session through control mode (safe when control mode is attached).
 * Uses a browser page connected to the default tmuxy session to send the command.
 */
async function createSessionViaControlMode(helperPage, sessionName, width = 120, height = 30) {
  await helperPage.evaluate(async (cmd) => {
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await window._adapter.invoke('run_tmux_command', { command: cmd });
      } catch (e) {
        lastError = e;
        if (e.message?.includes('No monitor connection')) {
          await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }, `new-session -d -s ${sessionName} -x ${width} -y ${height}`);
}

/**
 * Kill a tmux session through control mode (with timeout).
 */
async function killSessionViaControlMode(helperPage, sessionName) {
  const timeout = new Promise(resolve => setTimeout(resolve, 5000));
  const kill = helperPage.evaluate(async (cmd) => {
    try {
      return await window._adapter.invoke('run_tmux_command', { command: cmd });
    } catch { /* ignore */ }
  }, `kill-session -t ${sessionName}`);
  await Promise.race([kill, timeout]);
}

describe('Category 17: Widgets', () => {
  // Widget tests need longer timeout for session setup + command execution + widget rendering
  jest.setTimeout(60000);

  let browser;
  let helperPage; // Page connected to default tmuxy session for control mode commands
  let serverAvailable = false;
  let browserAvailable = false;

  // Per-test state
  let page;
  let session;

  beforeAll(async () => {
    // Wait for server
    const { waitForServer, getBrowser } = require('./helpers');
    try {
      await waitForServer(TMUXY_URL, 10000);
      serverAvailable = true;
    } catch {
      return;
    }

    try {
      browser = await getBrowser();
      browserAvailable = true;
    } catch {
      return;
    }

    // Open a helper page to the default tmuxy session for control mode commands
    helperPage = await browser.newPage();
    await helperPage.goto(`${TMUXY_URL}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await helperPage.waitForSelector('[role="log"]', { timeout: 10000 });
    // Wait for adapter to be available
    await helperPage.waitForFunction(() => !!window._adapter, { timeout: 10000 });

    // Warmup: create and destroy a session to prime control mode
    const warmupName = `tmuxy_warmup_${Date.now()}`;
    try {
      await createSessionViaControlMode(helperPage, warmupName);
      await killSessionViaControlMode(helperPage, warmupName);
    } catch { /* ignore warmup failures */ }
  });

  afterAll(async () => {
    if (helperPage) await helperPage.close().catch(() => {});
  });

  beforeEach(async () => {
    if (!serverAvailable || !browserAvailable) return;

    // Create session via control mode (safe, doesn't crash tmux)
    session = new TmuxTestSession();
    await createSessionViaControlMode(helperPage, session.name);
    session.created = true;

    // Source config
    try {
      await helperPage.evaluate(async (cmd) => {
        return await window._adapter.invoke('run_tmux_command', { command: cmd });
      }, `source-file ${require('path').resolve(__dirname, '..', 'docker/.tmuxy.conf')}`);
    } catch { /* config may not exist */ }

    page = await browser.newPage();
  });

  afterEach(async () => {
    // Close test page — this drops the test session's SSE/control mode connection.
    // Don't kill the session via control mode — it can disrupt the tmuxy session.
    // Orphaned sessions are cleaned up when the tmux server restarts.
    if (page) {
      await page.close().catch(() => {});
      page = null;
    }
    session = null;
  });

  function skipIfNotReady() {
    if (!serverAvailable || !browserAvailable || !page || !session) {
      console.log('Skipping test: prerequisites not available');
      return true;
    }
    return false;
  }

  async function setupPage() {
    await navigateToSession(page, session.name);
    await waitForSessionReady(page, session.name);
    session.setPage(page);
    await focusPage(page);
  }

  // ====================
  // 17.1 Image Widget
  // ====================
  describe('17.1 Image Widget', () => {
    test('Renders image, has pane header, no Terminal element', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      // Pipe a base64 data URI into tmuxy-widget (sleep keeps pipeline open so no prompt appears)
      sendCommand(session, `(echo "${RED_PNG}"; sleep 999) | /workspace/scripts/tmuxy/tmuxy-widget image`);

      // Wait for command to execute and pane content to propagate
      await delay(2000);
      await waitForSelector(page, '.widget-image', 20000);

      // Verify <img> has a base64 src
      const src = await page.evaluate(() => {
        const img = document.querySelector('.widget-image img');
        return img ? img.getAttribute('src') : null;
      });
      expect(src).toContain('data:image/png;base64,');

      // Widget pane should still have a pane header
      const hasPaneHeader = await page.evaluate(() => {
        const wrapper = document.querySelector('[data-pane-id]');
        if (!wrapper) return false;
        return wrapper.querySelector('.pane-tab, .pane-tabs') !== null;
      });
      expect(hasPaneHeader).toBe(true);

      // Terminal [role="log"] should NOT be present (replaced by widget)
      const hasTerminal = await page.evaluate(() => {
        const wrapper = document.querySelector('[data-pane-id]');
        if (!wrapper) return true;
        return wrapper.querySelector('[role="log"]') !== null;
      });
      expect(hasTerminal).toBe(false);
    });
  });

  // ====================
  // 17.2 Animation
  // ====================
  describe('17.2 Image Widget Animation', () => {
    test('Cycles through 3 base64 image frames', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      // Single inline command: echo all 3 frames with sleeps, piped into tmuxy-widget.
      // This is long (~450 chars) but with 60s timeout, send-keys typing time is fine.
      sendCommand(session, `(echo "${RED_PNG}"; sleep 1; echo "${BLUE_PNG}"; sleep 1; echo "${GREEN_PNG}"; sleep 999) | /workspace/scripts/tmuxy/tmuxy-widget image`);

      // Wait for widget to appear (command takes a few seconds to type via send-keys)
      await waitForSelector(page, '.widget-image', 30000);

      // Wait for the final frame (green) — widget updates as new lines arrive
      const greenSignature = GREEN_PNG.slice(-30);
      await page.waitForFunction((sig) => {
        const img = document.querySelector('.widget-image img');
        return img && img.src && img.src.includes(sig);
      }, greenSignature, { timeout: 30000, polling: 300 });

      // Verify final image src
      const finalSrc = await page.evaluate(() => {
        const img = document.querySelector('.widget-image img');
        return img ? img.src : null;
      });
      expect(finalSrc).toContain(greenSignature);
    });
  });

  // ====================
  // 17.3 Edge Cases
  // ====================
  describe('17.3 Widget Detection Edge Cases', () => {
    test('Normal pane without marker renders Terminal', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, 'echo "hello world"');
      await waitForTerminalText(page, 'hello world');

      // Should have Terminal, not widget
      const hasTerminal = await page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);

      const hasWidget = await page.evaluate(() =>
        document.querySelector('.widget-image') !== null
      );
      expect(hasWidget).toBe(false);
    });

    test('Unregistered widget name falls back to Terminal', async () => {
      if (skipIfNotReady()) return;
      await setupPage();

      sendCommand(session, 'echo "test" | /workspace/scripts/tmuxy/tmuxy-widget nonexistent_xyz');
      await waitForTerminalText(page, '__TMUXY_WIDGET__:nonexistent_xyz');

      // Should still be a terminal since "nonexistent_xyz" isn't registered
      const hasTerminal = await page.evaluate(() =>
        document.querySelector('[role="log"]') !== null
      );
      expect(hasTerminal).toBe(true);
    });
  });
});
