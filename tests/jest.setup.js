// Jest setup for E2E tests

const { execSync } = require('child_process');

// Increase timeout for all tests
// Hook and test timeout is set by testTimeout in jest.config.js (240000ms)

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Cold-start warmup: absorb first-run latency (browser launch, server SSE init,
// control mode attachment) so Scenario 1 doesn't bear the cost.
const { getBrowser, waitForServer, navigateToSession, waitForSessionReady, delay } = require('./helpers/browser');
const { TMUXY_URL, WORKSPACE_ROOT } = require('./helpers/config');

let _weStartedServer = false;

beforeAll(async () => {
  // Auto-start dev server if not running
  let serverRunning = false;
  try {
    const response = await fetch(TMUXY_URL);
    serverRunning = response.ok;
  } catch {
    // Server not running
  }

  if (!serverRunning) {
    try {
      execSync('npm start', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
      _weStartedServer = true;
      await waitForServer(TMUXY_URL, 120000);
    } catch (error) {
      console.error('[setup] Failed to start server:', error.message);
      throw error;
    }
  }

  const warmupStart = Date.now();

  try {
    await waitForServer(TMUXY_URL, 15000);
    const browser = await getBrowser();
    const context = await browser._browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const warmupSession = `warmup_${Date.now()}`;
    await navigateToSession(page, warmupSession);

    try {
      await waitForSessionReady(page, warmupSession);
    } catch {
      // Warmup session readiness is best-effort
    }

    // Kill the warmup session and close the page
    try {
      await page.evaluate(async () => {
        await window._adapter?.invoke('run_tmux_command', { command: 'kill-session' });
      });
    } catch {
      // Best effort
    }

    await page.close().catch(() => {});
    await delay(2000); // Let server clean up

    void warmupStart; // Used for timing, value not needed
  } catch {
    // Warmup failure is non-fatal
  }
}, 180000);

afterAll(async () => {
  if (_weStartedServer) {
    try {
      execSync('npm run stop', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
    } catch {
      // Best effort
    }
  }
});
