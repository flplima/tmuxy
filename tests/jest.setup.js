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
const { tmuxQuery } = require('./helpers/cli');

let _weStartedServer = false;
let _serverPid = null;

beforeAll(async () => {
  // Auto-start production server if not running
  let serverRunning = false;
  try {
    const response = await fetch(TMUXY_URL);
    serverRunning = response.ok;
  } catch {
    // Server not running
  }

  if (!serverRunning) {
    try {
      console.warn('[setup] Building frontend and server...');
      execSync('npm run build -w tmuxy-ui', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
      execSync('cargo build --release -p tmuxy-server', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
      console.warn('[setup] Starting production server...');
      const { spawn } = require('child_process');
      const server = spawn('./target/release/tmuxy-server', [], {
        cwd: WORKSPACE_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      server.unref();
      _weStartedServer = true;
      _serverPid = server.pid;
      await waitForServer(TMUXY_URL, 120000);
    } catch (error) {
      console.error('[setup] Failed to start server:', error.message);
      throw error;
    }
  }

  // Cold-start warmup: open a browser page to trigger SSE init and server warmup
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

    // Kill the warmup session via CLI and close the page
    try {
      tmuxQuery(`kill-session -t ${warmupSession}`);
    } catch {
      // Best effort
    }

    await page.close().catch(() => {});
    await delay(2000); // Let server clean up
  } catch {
    // Warmup failure is non-fatal
  }
}, 180000);

afterAll(async () => {
  if (_weStartedServer && _serverPid) {
    try {
      process.kill(_serverPid);
    } catch {
      // Best effort — process may already be gone
    }
  }
});
