/**
 * What a web E2E run may stop when it ends.
 *
 * Decided once, as the run starts (`jest.global-setup.js`): a run that finds a
 * tmuxy server answering on its URL reuses it, and leaves it and its tmux
 * server as they are. A run that finds none owns its tmux socket: it stops a
 * tmux server left there by an earlier run, and stops its own when it ends
 * (`jest.global-teardown.js`, or a signal). The servers it starts, shared or a
 * test's own, are its to stop in both cases; each is written into the run's
 * record file, which the test files and the run's own process both reach.
 *
 * The tmuxy servers go first. tmux is only asked anything once no control-mode
 * client is attached to the socket: an outside command beside one can crash it
 * (docs/TMUX.md). Everything here is synchronous, so that an interrupted run
 * finishes stopping before another signal handler can exit the process.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { waitBudget } = require('./config');
const { liveSocketProblem, liveSocketDirectory } = require('./live-socket-guard');
const { scrubbedEnv, tmuxBin } = require('./tmux-socket');

/** Names the record file of the run in progress; unset outside a web E2E run. */
const RECORD_ENV = 'TMUXY_E2E_RUN_RECORD';

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];

/** What a run owns, from what it finds as it starts. */
function decideOwnership({ serverAnswers, tmuxRunning }) {
  return { owns: !serverAnswers, leftover: !serverAnswers && tmuxRunning };
}

function record(entry) {
  const file = process.env[RECORD_ENV];
  if (file) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** A tmuxy server this run started, for the run to see gone. */
function recordServer(pid, binary) {
  record({ pid, binary });
}

/** A tmux socket (a name or a path) this run made beside its own. */
function recordTmuxSocket(socket) {
  record({ socket });
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

/** `ps` for one process, or '' when there is none. */
function ps(pid, format) {
  return spawnSync('ps', ['-ww', '-o', format, '-p', String(pid)], {
    encoding: 'utf8',
  }).stdout.trim();
}

/** Whether `pid` is still running (a zombie has exited). */
function isRunning(pid) {
  const state = ps(pid, 'stat=');
  return state !== '' && !state.startsWith('Z');
}

/**
 * The pids of the control-mode clients of `socket` in a `ps -o pid=,tty=,args=`
 * listing. A tmux server keeps the arguments of the client that started it, so
 * the two are told apart by the terminal: a client has one, a server has none.
 */
function controlClientsIn(listing, socket, socketDirectory = liveSocketDirectory()) {
  const spellings = socket.includes('/')
    ? [`-S ${socket}`]
    : [`-L ${socket}`, `-S ${path.join(socketDirectory, socket)}`];
  return listing
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .filter(([, , tty, args]) => {
      const words = ` ${args} `;
      return (
        !tty.startsWith('?') &&
        words.includes(' -CC ') &&
        spellings.some((spelling) => words.includes(` ${spelling} `))
      );
    })
    .map(([, pid]) => Number(pid));
}

/** `tmux <args>` on `socket`, with nothing of the shell's own tmux. */
function tmux(socket, args) {
  const flag = socket.includes('/') ? '-S' : '-L';
  return spawnSync(tmuxBin(), [flag, socket, ...args], {
    env: scrubbedEnv(),
    encoding: 'utf8',
    timeout: waitBudget(10000),
  });
}

/** The processes and tmux servers of this machine, as the run sees them. */
const machine = {
  serverRunning: ({ pid, binary }) => isRunning(pid) && ps(pid, 'args=').includes(binary),
  signal(pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone since it was last looked at.
    }
  },
  controlClients(socket) {
    const listing = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,tty=,args='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listing.status !== 0) throw new Error(`ps failed: ${listing.error ?? listing.stderr}`);
    return controlClientsIn(listing.stdout, socket);
  },
  /** The pid of the tmux server on `socket`, or null when there is none. */
  tmuxPid(socket) {
    const asked = tmux(socket, ['display-message', '-p', '#{pid}']);
    if (asked.status === 0 && Number(asked.stdout) > 0) return Number(asked.stdout);
    if (/no server running|error connecting to/.test(asked.stderr)) return null;
    throw new Error(
      `cannot tell whether a tmux server is on "${socket}": ${asked.error ?? asked.stderr.trim()}`,
    );
  },
  killTmux: (socket) => tmux(socket, ['kill-server']),
  tmuxRunning: isRunning,
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/** Wait until `still()` names nothing, or throw naming what is still there. */
function waitUntilGone(system, still, timeout) {
  const deadline = Date.now() + timeout;
  for (let left = still(); left; left = still()) {
    if (Date.now() >= deadline) throw new Error(`[e2e] ${left} after ${timeout} ms`);
    system.sleep(100);
  }
}

/**
 * Stop the tmux server on `socket` once nothing is attached to it in control
 * mode, and wait for it to exit. Returns its pid, or null when there was none.
 */
function stopTmux(socket, { system = machine, timeout = waitBudget(15000) } = {}) {
  const problem = liveSocketProblem({ socket });
  if (problem) throw new Error(`[e2e] Not stopping tmux on "${socket}": ${problem}.`);
  waitUntilGone(
    system,
    () => {
      const clients = system.controlClients(socket);
      return (
        clients.length > 0 &&
        `a control-mode client (pid ${clients.join(', ')}) is still attached to tmux socket "${socket}"`
      );
    },
    timeout,
  );
  const pid = system.tmuxPid(socket);
  if (pid === null) return null;
  const killed = system.killTmux(socket);
  waitUntilGone(
    system,
    () =>
      system.tmuxRunning(pid) &&
      `the tmux server (pid ${pid}) on "${socket}" is still running ${killed?.stderr?.trim() ?? ''}`,
    timeout,
  );
  return pid;
}

/**
 * Take the run's place on `socket`: decide what it owns, clear a leftover, and
 * return the handle whose `release()` stops what the run leaves behind.
 */
function claimRun({
  serverAnswers,
  socket,
  url,
  recordFile = path.join(os.tmpdir(), `tmuxy-e2e-run-${process.pid}.ndjson`),
  system = machine,
  timeout = waitBudget(15000),
  log = (line) => fs.writeSync(2, `${line}\n`),
}) {
  const stop = (which) => stopTmux(which, { system, timeout });
  // A reused server's tmux is never asked anything: its client is attached.
  const { owns, leftover } = decideOwnership({
    serverAnswers,
    tmuxRunning: !serverAnswers && hasTmux(socket, { system, timeout }),
  });
  if (owns) {
    log(
      `[e2e] Nothing answers on ${url}: this run owns tmux socket "${socket}" ` +
        `and stops its tmux server when it ends.`,
    );
  } else {
    log(
      `[e2e] A server already answers on ${url}: this run reuses it, ` +
        `and leaves it and its tmux server as they are.`,
    );
  }
  if (leftover) {
    const pid = stop(socket);
    log(`[e2e] Stopped a leftover tmux server (pid ${pid}) on socket "${socket}".`);
  }

  fs.rmSync(recordFile, { force: true });
  process.env[RECORD_ENV] = recordFile;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const records = readRecords(recordFile);
    const servers = records.filter((entry) => entry.pid);
    const running = () => servers.filter((server) => system.serverRunning(server));
    for (const { pid } of running()) system.signal(pid);
    waitUntilGone(
      system,
      () => {
        const left = running().map((server) => server.pid);
        return left.length > 0 && `the tmuxy server (pid ${left.join(', ')}) is still running`;
      },
      timeout,
    );
    const extra = records.map((entry) => entry.socket).filter((other) => other && other !== socket);
    const failures = [];
    for (const which of new Set([...(owns ? [socket] : []), ...extra])) {
      try {
        const pid = stop(which);
        if (pid !== null) log(`[e2e] Stopped the tmux server (pid ${pid}) on socket "${which}".`);
      } catch (error) {
        failures.push(error.message);
      }
    }
    fs.rmSync(recordFile, { force: true });
    if (failures.length > 0) throw new Error(failures.join('\n'));
  };

  return { owns, release };
}

/**
 * Whether a tmux server is on `socket`, asked once its control-mode clients are
 * gone: those of a server killed a moment ago take a while to leave.
 */
function hasTmux(socket, { system, timeout }) {
  waitUntilGone(
    system,
    () => {
      const clients = system.controlClients(socket);
      return (
        clients.length > 0 &&
        `no server answers, yet a control-mode client (pid ${clients.join(', ')}) is attached ` +
          `to tmux socket "${socket}": stop what runs it, or name another TMUX_SOCKET;`
      );
    },
    timeout,
  );
  return system.tmuxPid(socket) !== null;
}

/**
 * Release `run` when the process is interrupted, then exit as the signal would
 * have. The listeners stay on, so a second Ctrl-C does not cut the stop short.
 */
function releaseOnSignal(run) {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      try {
        run.release();
      } catch (error) {
        console.error(error.message);
      }
      process.exit(128 + os.constants.signals[signal]);
    });
  }
}

module.exports = {
  decideOwnership,
  claimRun,
  releaseOnSignal,
  recordServer,
  recordTmuxSocket,
  controlClientsIn,
};
