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
  // Ensure tmux server stays alive between tests. When tests destroy their
  // sessions via kill-session, the tmux server exits if no sessions remain.
  // This keepalive session prevents that crash.
  try {
    execSync('tmux has-session -t _keepalive 2>/dev/null || tmux new-session -d -s _keepalive', {
      timeout: 5000,
    });
  } catch {
    // tmux server may not be running yet — it will be started by the web server
  }

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
      const fs = require('fs');
      const serverStderr = fs.openSync('/tmp/tmuxy-server-stderr.log', 'w');
      const server = spawn('./target/release/tmuxy-server', [], {
        cwd: WORKSPACE_ROOT,
        stdio: ['ignore', 'ignore', serverStderr],
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

  // Ensure keepalive session exists now that the server (and tmux) is running.
  // This prevents the tmux server from exiting when test sessions are destroyed.
  try {
    execSync('tmux has-session -t _keepalive 2>/dev/null || tmux new-session -d -s _keepalive', {
      timeout: 5000,
    });
  } catch {
    // Best effort
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

    // Close the page so the server's CC connection shuts down cleanly.
    // Do NOT kill the warmup session via subprocess — running external tmux
    // commands while ANY CC client is attached crashes tmux 3.5a. The orphaned
    // session is harmless and gets cleaned up when the tmux server resets or
    // the _keepalive session is killed in afterAll.
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    // Wait for server's 2s grace period + CC cleanup
    await delay(4000);
  } catch {
    // Warmup failure is non-fatal
  }
}, 180000);

afterAll(async () => {
  // Clean up keepalive session
  try {
    execSync('tmux kill-session -t _keepalive 2>/dev/null', { timeout: 5000 });
  } catch {
    // Best effort
  }

  if (_weStartedServer && _serverPid) {
    try {
      process.kill(_serverPid);
    } catch {
      // Best effort — process may already be gone
    }
  }
});
