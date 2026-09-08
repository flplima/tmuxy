// Jest setup for E2E tests

const { execSync } = require('child_process');

// Pin the tmux socket before anything can shell out.
//
// The suite mutates tmux through `bin/tmuxy-cli`, which derives its socket from
// $TMUX when TMUX_SOCKET is unset. Running the suite from inside a tmux pane —
// the normal case for a tmux tool — would therefore aim every split, kill and
// send-keys at whatever server the developer's shell is attached to, wrecking a
// real working session. Inheriting $TMUX also splits reads and writes across
// two different servers, since the read helpers resolve the socket themselves.
//
// The default is the suite's own socket, never the one a live tmuxy serves —
// see DEFAULT_SOCKET in helpers/tmux-socket.js.
const { DEFAULT_SOCKET, tmuxEnv, tmuxSocket } = require('./helpers/tmux-socket');

process.env.TMUX_SOCKET = process.env.TMUX_SOCKET || DEFAULT_SOCKET;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

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

  if (serverRunning) {
    // A server that was already up is used as-is, and it reports no socket, so
    // this cannot be verified — only flagged. When it is attached elsewhere,
    // every test fails at "session not found" while the UI looks fine, which
    // is a genuinely confusing hour if nobody said this out loud.
    console.warn(
      `[setup] Reusing the server already on ${TMUXY_URL}. This suite drives ` +
        `tmux socket "${tmuxSocket()}"; if that server is attached to another ` +
        `socket, stop it and re-run, or start it with ` +
        `TMUX_SOCKET=${tmuxSocket()}.`,
    );
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
      // Explicit env, not the inherited one: the server is the other half of
      // every round trip, so it has to attach to the socket the helpers read
      // and write. tmuxEnv() is the same resolution they use.
      const server = spawn('./target/release/tmuxy-server', [], {
        cwd: WORKSPACE_ROOT,
        stdio: ['ignore', 'ignore', serverStderr],
        detached: true,
        env: tmuxEnv(),
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
