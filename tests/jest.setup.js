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

const { waitForServer, disconnectBrowser } = require('./helpers/browser');
const { TMUXY_PORT, TMUXY_URL, WORKSPACE_ROOT } = require('./helpers/config');

/**
 * The tmux socket the server on `TMUXY_URL` is attached to, or null when it
 * cannot be asked.
 *
 * `query_tmux` is the client's own read path, answered in-band on the monitor's
 * control-mode connection, so this is tmux itself reporting which socket that
 * connection is on — not a guess from the port or the process table.
 *
 * The monitor only exists while a client is attached, so this attaches one the
 * way the browser does — an `/events` stream, held open for the query and
 * dropped after — rather than adding an endpoint the app itself would not use.
 */
async function serverSocketPath() {
  const stream = new AbortController();
  try {
    // Deliberately not awaited to completion: an SSE stream never ends. The
    // response resolving is the connection being accepted; the monitor comes up
    // a moment later, which is what the retry below waits for.
    fetch(`${TMUXY_URL}/events`, { signal: stream.signal }).catch(() => {});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await fetch(`${TMUXY_URL}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'query_tmux',
          args: { command: "display-message -p -F '#{socket_path}'" },
        }),
      });
      const body = response.ok ? await response.json() : {};
      if (typeof body.result === 'string' && body.result.trim()) return body.result.trim();
      // The monitor attaches asynchronously after the stream is accepted, so an
      // early "no monitor connection" is NOT an answer — keep waiting.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  } catch {
    return null;
  } finally {
    stream.abort();
  }
}

/**
 * Whether a socket path reported by a server is this run's socket.
 *
 * `TMUX_SOCKET` is a name (`-L tmuxy-test`) or a full path (`-S /tmp/...`);
 * tmux always answers with the path, so a name is compared against its last
 * segment.
 */
function isOurSocket(socketPath) {
  const ours = tmuxSocket();
  return ours.includes('/') ? socketPath === ours : socketPath.split('/').pop() === ours;
}

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
    // A server that was already up is only reused once it has said it is on
    // this run's socket. One that is not — a dev server, another agent's run —
    // fails every test at "session not found" while the UI looks perfectly
    // fine: a wall of unrelated flakes instead of the one real problem. Ask it,
    // and refuse rather than spend an hour reading the wrong symptom.
    const socketPath = await serverSocketPath();
    if (!socketPath) {
      throw new Error(
        `[setup] A server answers on ${TMUXY_URL} but would not say which tmux ` +
          `socket it is on, so it cannot be reused. Stop it and re-run, or ` +
          `point this run elsewhere with TMUXY_PORT.`,
      );
    }
    if (!isOurSocket(socketPath)) {
      throw new Error(
        `[setup] The server on ${TMUXY_URL} drives tmux socket "${socketPath}", ` +
          `but this suite drives "${tmuxSocket()}". Stop that server and ` +
          `re-run, start it with TMUX_SOCKET=${tmuxSocket()}, or give this run ` +
          `a port of its own with TMUXY_PORT.`,
      );
    }
    console.warn(`[setup] Reusing the server already on ${TMUXY_URL} (socket ${socketPath}).`);
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
      // Explicit port AND explicit env, not the inherited ones: the server is
      // the other half of every round trip, so it has to listen where the
      // helpers look and attach to the socket they read and write. Without
      // `--port` it took the default 9000 whatever TMUXY_PORT said, so two
      // runs — or a run and a dev server — fought over one port while each
      // believed it had its own. tmuxEnv() is the helpers' own resolution.
      const server = spawn('./target/release/tmuxy-server', ['--port', String(TMUXY_PORT)], {
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
  // Release the shared browser so the process can exit on its own; without
  // this the run needed `--forceExit`, which also hid every other leak.
  await disconnectBrowser();

  if (_weStartedServer && _serverPid) {
    try {
      process.kill(_serverPid);
    } catch {
      // Best effort — process may already be gone
    }
  }
});
