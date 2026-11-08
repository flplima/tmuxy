const { execSync, execFileSync } = require('child_process');
const path = require('path');

// Every child process gets the suite's socket and dirs from `tmuxEnv()`
// (helpers/tmux-socket.js), never this process's environment, which may name
// the developer's own tmux (`$TMUX`) or socket.
const { tmuxEnv, tmuxSocket, stateDir } = require('./helpers/tmux-socket');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const { waitForServer, disconnectBrowser } = require('./helpers/browser');
const { TMUXY_PORT, TMUXY_URL, WORKSPACE_ROOT, serverBinary } = require('./helpers/config');

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
    // Explicitly ensure the default session exists before opening `/events`
    // (`GET /events` attaches only to an existing session).
    await fetch(`${TMUXY_URL}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'ensure_session', args: {} }),
    }).catch(() => {});
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
  let serverRunning = false;
  try {
    const response = await fetch(TMUXY_URL);
    serverRunning = response.ok;
  } catch {
    // Not running: started below.
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
      // A fresh server starts from nothing: no snapshot of a previous run's
      // session to rebuild (see `stateDir` in helpers/tmux-socket.js). Only
      // the snapshots: the trace beside them is the whole run's, and a suite
      // that brings the server down mid-run must not take it with it.
      fs.rmSync(require('path').join(stateDir(), 'sessions'), { recursive: true, force: true });
      // Explicit port AND explicit env, not the inherited ones: the server is
      // the other half of every round trip, so it has to listen where the
      // helpers look (without `--port` it takes 9000, whatever TMUXY_PORT
      // says) and attach to the socket they read and write.
      // Traced, so a failure can be read across the layers rather than from
      // its last log lines (docs/TRACING.md; markers per test come from
      // tests/helpers/trace-environment.js). The state dir was just cleared,
      // so the file is this run's alone.
      const server = spawn(
        serverBinary(),
        ['--port', String(TMUXY_PORT), '--trace', process.env.TMUXY_E2E_TRACE],
        {
          cwd: WORKSPACE_ROOT,
          stdio: ['ignore', 'ignore', serverStderr],
          detached: true,
          env: { ...tmuxEnv(), TMUXY_TRACE_LEVEL: 'labeled' },
        },
      );
      server.unref();
      _weStartedServer = true;
      _serverPid = server.pid;
      await waitForServer(TMUXY_URL, 120000);
    } catch (error) {
      console.error('[setup] Failed to start server:', error.message);
      throw error;
    }
  }
}, 180000);

afterAll(async () => {
  // Release the shared browser so the process exits on its own, without
  // `--forceExit` hiding every other leaked handle.
  await disconnectBrowser();

  if (_weStartedServer && _serverPid) {
    try {
      process.kill(_serverPid);
    } catch {
      // Already gone.
    }
  }

  // A run creates and destroys hundreds of panes, and each teardown races the
  // shell's own start-up: one that loses hangs in the kernel holding a PTY
  // slave, outliving the run. The per-session follow-up in
  // `TmuxTestSession.destroy` catches the ones it knows the pids of; this is
  // the net under the whole run, so a suite can never leave the machine with
  // fewer pseudoterminals than it found.
  try {
    const reaped = execFileSync(
      'bash',
      [path.join(WORKSPACE_ROOT, 'packages/tmuxy-cli/bin/tmuxy/reap-orphan-shells')],
      {
        encoding: 'utf-8',
        timeout: 15000,
      },
    ).trim();
    if (!reaped.startsWith('No orphaned')) console.warn(`[jest] ${reaped}`);
  } catch {
    // Best effort — never fail a green run over cleanup
  }
});
