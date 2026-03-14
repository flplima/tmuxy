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

  // No keepalive session — the server's monitor loop handles tmux server
  // restarts by recreating sessions with create_session=true. A subprocess
  // `tmux new-session` to create _keepalive races with the server's CC
  // connection and can cause SessionsChanged/UnlinkedWindowClose events
  // that crash the monitor.

  // No warmup session — previous approach created a browser page + CC
  // connection that raced with the first real test's CC connection.
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
