/**
 * tmuxy event emit / wait / list — the inter-agent coordination queue.
 *
 * Storage is /tmp/tmuxy-events/<socket>/<name>/ with flock-serialized
 * sequence allocation and consume. Each test uses a unique socket name so
 * runs are isolated from each other and from any real queue. The tmux mock
 * absorbs the `wait-for` signal/block calls, so `event wait` only takes the
 * fast path here (message already pending) — blocking-wait wakeups need a
 * real tmux and live in the E2E tier.
 */

const fs = require('fs');
const { runCLI } = require('./helpers/run-cli');

/** Unique socket per test → unique /tmp/tmuxy-events namespace. */
function freshSocket() {
  return `tmuxy-evt-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventDir(socket, name) {
  return `/tmp/tmuxy-events/${socket}/${name}`;
}

function cleanup(socket) {
  fs.rmSync(`/tmp/tmuxy-events/${socket}`, { recursive: true, force: true });
}

describe('CLI event subcommands', () => {
  describe('event emit', () => {
    test('writes the message and signals waiters', () => {
      const socket = freshSocket();
      try {
        const { exitCode, tmuxCalls } = runCLI(['event', 'emit', 'build-done', 'ok'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        // Message persisted at sequence 0 with the exact payload.
        const dir = eventDir(socket, 'build-done');
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('ok');
        expect(fs.readFileSync(`${dir}/next`, 'utf-8').trim()).toBe('1');
        // Blocked waiters are woken via tmux wait-for -S.
        const waitFor = tmuxCalls.find((c) => c.args[0] === 'wait-for');
        expect(waitFor).toBeDefined();
        expect(waitFor.args).toEqual(['wait-for', '-S', 'tmuxy_evt_build-done']);
      } finally {
        cleanup(socket);
      }
    });

    test('sequences multiple messages', () => {
      const socket = freshSocket();
      try {
        runCLI(['event', 'emit', 'ch', 'first'], { env: { TMUX_SOCKET: socket } });
        runCLI(['event', 'emit', 'ch', 'second'], { env: { TMUX_SOCKET: socket } });
        const dir = eventDir(socket, 'ch');
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('first');
        expect(fs.readFileSync(`${dir}/msg.1`, 'utf-8')).toBe('second');
        expect(fs.readFileSync(`${dir}/next`, 'utf-8').trim()).toBe('2');
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('event wait', () => {
    test('delivers pending messages in order, exactly once', () => {
      const socket = freshSocket();
      try {
        runCLI(['event', 'emit', 'ch', 'first'], { env: { TMUX_SOCKET: socket } });
        runCLI(['event', 'emit', 'ch', 'second'], { env: { TMUX_SOCKET: socket } });

        const w1 = runCLI(['event', 'wait', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(w1.exitCode).toBe(0);
        expect(w1.stdout).toBe('first');

        const w2 = runCLI(['event', 'wait', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(w2.exitCode).toBe(0);
        expect(w2.stdout).toBe('second');

        // Both consumed: cursor advanced, message files removed.
        const dir = eventDir(socket, 'ch');
        expect(fs.readFileSync(`${dir}/cursor`, 'utf-8').trim()).toBe('1');
        expect(fs.existsSync(`${dir}/msg.0`)).toBe(false);
        expect(fs.existsSync(`${dir}/msg.1`)).toBe(false);
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('event list', () => {
    test('reports pending counts per channel', () => {
      const socket = freshSocket();
      try {
        runCLI(['event', 'emit', 'alpha', 'a-message'], { env: { TMUX_SOCKET: socket } });
        runCLI(['event', 'emit', 'alpha', 'another'], { env: { TMUX_SOCKET: socket } });
        runCLI(['event', 'emit', 'beta', 'b-message'], { env: { TMUX_SOCKET: socket } });
        runCLI(['event', 'wait', 'beta'], { env: { TMUX_SOCKET: socket } });

        const { exitCode, stdout } = runCLI(['event', 'list'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/alpha\s+pending=2/);
        expect(stdout).toMatch(/beta\s+pending=0/);
        // The oldest unconsumed payload is previewed.
        expect(stdout).toContain('a-message');
      } finally {
        cleanup(socket);
      }
    });

    test('reports no channels for an unused socket', () => {
      const socket = freshSocket();
      const { exitCode, stdout } = runCLI(['event', 'list'], {
        env: { TMUX_SOCKET: socket },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No event channels');
    });
  });
});
