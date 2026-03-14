// Jest setup for E2E tests

const { execSync } = require('child_process');

// Increase timeout for all tests
// Hook and test timeout is set by testTimeout in jest.config.js (240000ms)

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const { waitForServer } = require('./helpers/browser');
const { TMUXY_URL, WORKSPACE_ROOT } = require('./helpers/config');

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

  // No warmup session — previous warmup approach created a browser page +
  // CC connection that raced with the first real test's CC connection. The
  // warmup's CC cleanup (grace period + detach) didn't always finish before
  // the next test's monitor ran `tmux has-session` subprocess, which crashes
  // tmux 3.5a when ANY CC client is still attached. Tests handle cold-start
  // latency with their own waitForFunction/waitForSessionReady timeouts.
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
