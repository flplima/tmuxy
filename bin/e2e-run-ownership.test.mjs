import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  decideOwnership,
  claimRun,
  recordServer,
  recordTmuxSocket,
  controlClientsIn,
} = require('../tests/helpers/run-ownership.js');

const SOCKET = 'tmuxy-e2e-unit';

// What an E2E run stops, with the machine played by a table: no process, no
// tmux server, no signal.
describe('an E2E run and the servers it may stop', () => {
  let dir;
  let tmux;
  let clients;
  let servers;
  let done;
  let lines;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxy-e2e-run-'));
    tmux = new Map();
    clients = new Map();
    servers = new Set();
    done = [];
    lines = [];
  });
  afterEach(() => {
    delete process.env.TMUXY_E2E_RUN_RECORD;
    rmSync(dir, { recursive: true, force: true });
  });

  const system = {
    serverRunning: ({ pid }) => servers.has(pid),
    signal(pid) {
      done.push(`stop tmuxy ${pid}`);
      servers.delete(pid);
      // Its control-mode client goes with it.
      clients.clear();
    },
    controlClients: (socket) => clients.get(socket) ?? [],
    tmuxPid(socket) {
      expect(clients.get(socket) ?? []).toEqual([]);
      return tmux.get(socket) ?? null;
    },
    killTmux(socket) {
      done.push(`stop tmux ${socket}`);
      tmux.delete(socket);
    },
    tmuxRunning: (pid) => [...tmux.values()].includes(pid),
    sleep() {},
  };

  const claim = (found = {}) =>
    claimRun({
      serverAnswers: false,
      socket: SOCKET,
      url: 'http://localhost:1',
      recordFile: join(dir, 'record'),
      system,
      timeout: 20,
      log: (line) => lines.push(line),
      ...found,
    });

  /** A server the run starts, and the tmux it brings up. */
  const startServer = (pid) => {
    servers.add(pid);
    recordServer(pid, 'tmuxy-server');
    tmux.set(SOCKET, 900);
    clients.set(SOCKET, [pid + 1]);
  };

  it.each([
    [false, false, { owns: true, leftover: false }],
    [false, true, { owns: true, leftover: true }],
    [true, false, { owns: false, leftover: false }],
    [true, true, { owns: false, leftover: false }],
  ])('server answering: %s, tmux running: %s', (serverAnswers, tmuxRunning, expected) => {
    expect(decideOwnership({ serverAnswers, tmuxRunning })).toEqual(expected);
  });

  it('owning, stops its tmuxy servers and then its tmux server, once', () => {
    const run = claim();
    startServer(10);
    startServer(20);
    run.release();
    run.release();
    expect(done).toEqual(['stop tmuxy 10', 'stop tmuxy 20', `stop tmux ${SOCKET}`]);
    expect(lines.join('\n')).toContain('this run owns tmux socket');
  });

  it('reusing, stops neither the server it was given nor that tmux', () => {
    servers.add(1);
    tmux.set(SOCKET, 900);
    clients.set(SOCKET, [2]);
    const run = claim({ serverAnswers: true });
    run.release();
    expect(done).toEqual([]);
    expect(lines.join('\n')).toContain('this run reuses it');
  });

  it('reusing, still stops the servers and sockets of its tests’ own', () => {
    tmux.set(SOCKET, 900);
    const run = claim({ serverAnswers: true });
    servers.add(30);
    recordServer(30, 'tmuxy-server');
    tmux.set('tmuxy-snapshot-1', 901);
    recordTmuxSocket('tmuxy-snapshot-1');
    run.release();
    expect(done).toEqual(['stop tmuxy 30', 'stop tmux tmuxy-snapshot-1']);
  });

  it('stops a leftover tmux server before it starts, and says so', () => {
    tmux.set(SOCKET, 800);
    claim();
    expect(done).toEqual([`stop tmux ${SOCKET}`]);
    expect(lines.join('\n')).toContain('Stopped a leftover tmux server (pid 800)');
  });

  it('leaves tmux alone, and fails, while a client stays attached with no server answering', () => {
    tmux.set(SOCKET, 800);
    clients.set(SOCKET, [7]);
    expect(() => claim()).toThrow(/control-mode client \(pid 7\)/);
    expect(done).toEqual([]);
  });

  it('fails, and leaves tmux alone, when its tmuxy server will not exit', () => {
    const run = claim({ system: { ...system, signal() {} } });
    startServer(10);
    expect(() => run.release()).toThrow(/tmuxy server \(pid 10\) is still running/);
    expect(done).toEqual([]);
  });

  it('never stops a socket people work in', () => {
    const run = claim();
    tmux.set('tmuxy', 1);
    recordTmuxSocket('tmuxy');
    expect(() => run.release()).toThrow(/socket people work in/);
    expect(done).toEqual([]);
  });

  it('tells a control-mode client, which has a terminal, from the server it started', () => {
    const argv = `tmux -L ${SOCKET} -f /x.conf -CC new-session -A -s s`;
    const listing = [
      `  10 ?        ${argv}`,
      `  11 pts/4    ${argv}`,
      `  12 ??       ${argv}`,
      `  13 ttys001  tmux -S /sockets/${SOCKET} -CC attach-session -t s`,
      `  14 pts/5    tmux -L ${SOCKET}-other -CC attach-session -t s`,
      `  15 pts/6    tmux -L ${SOCKET} attach`,
    ].join('\n');
    expect(controlClientsIn(listing, SOCKET, '/sockets')).toEqual([11, 13]);
  });
});
