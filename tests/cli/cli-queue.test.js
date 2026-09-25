/**
 * tmuxy queue (alias: q) — the inter-agent coordination queue.
 *
 * Storage is <runtime dir>/tmuxy-queues-<uid>/<socket>/<name>/, with sequence
 * allocation and consume serialized by the mkdir mutex in bin/tmuxy/_lib
 * (mkdir rather than flock, which macOS does not ship). The root is per-user
 * and 0700 so another local account cannot read the messages, plant its own,
 * or pre-create the path as a symlink. Each test uses a unique socket name so
 * runs are isolated from each other and from any real queue.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI, runCLIConcurrent, reapedPid } = require('./helpers/run-cli');

/** Unique socket per test → unique queue namespace. */
function freshSocket() {
  return `tmuxy-queue-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The root the scripts compute, mirrored here so the tests read real files. */
function queueRoot() {
  return path.join(process.env.XDG_RUNTIME_DIR || '/tmp', `tmuxy-queues-${os.userInfo().uid}`);
}

function queueDir(socket, name) {
  return path.join(queueRoot(), socket, name);
}

function cleanup(socket) {
  fs.rmSync(path.join(queueRoot(), socket), { recursive: true, force: true });
}

describe('CLI queue subcommands', () => {
  /**
   * SEC-06. The name becomes a PATH SEGMENT, and it arrives from whatever asked
   * for the queue — an agent passing an untrusted string is the realistic
   * route. `tmuxy queue clear ../../../foo` ended in `rm -rf /tmp/foo`.
   */
  describe('queue name validation', () => {
    test.each([
      ['../../../etc', 'a traversal out of the queue root'],
      ['..', 'the parent directory itself'],
      ['a/b', 'a nested path'],
      ['.hidden', 'a leading dot'],
      ['', 'an empty name'],
    ])('refuses %s (%s)', (name) => {
      const socket = freshSocket();
      try {
        for (const verb of ['push', 'peek', 'pop', 'clear']) {
          const args = verb === 'push' ? ['queue', verb, name, 'x'] : ['queue', verb, name];
          const result = runCLI(args, { socket });
          expect(result.status).not.toBe(0);
        }
      } finally {
        cleanup(socket);
      }
    });

    test('a traversing clear removes nothing outside the queue root', () => {
      const socket = freshSocket();
      const bystander = path.join(os.tmpdir(), `tmuxy-sec06-${process.pid}`);
      fs.mkdirSync(bystander, { recursive: true });
      fs.writeFileSync(path.join(bystander, 'keep'), 'still here');
      try {
        const escape = path.relative(queueDir(socket, 'x'), bystander);
        runCLI(['queue', 'clear', escape], { socket });
        expect(fs.existsSync(path.join(bystander, 'keep'))).toBe(true);
      } finally {
        fs.rmSync(bystander, { recursive: true, force: true });
        cleanup(socket);
      }
    });

    test('the queue root is readable only by its owner', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'ok', 'hello'], { socket });
        const mode = fs.statSync(queueRoot()).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('queue push & send', () => {
    test('writes the message and signals waiters', () => {
      const socket = freshSocket();
      try {
        const { exitCode, tmuxCalls } = runCLI(['queue', 'push', 'build-done', 'ok'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        // Message persisted at sequence 0 with the exact payload.
        const dir = queueDir(socket, 'build-done');
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('ok');
        expect(fs.readFileSync(`${dir}/next`, 'utf-8').trim()).toBe('1');
        // Blocked waiters are woken via tmux wait-for -S.
        const waitFor = tmuxCalls.find((c) => c.args[0] === 'wait-for');
        expect(waitFor).toBeDefined();
        expect(waitFor.args).toEqual(['wait-for', '-S', 'tmuxy_queue_build-done']);
      } finally {
        cleanup(socket);
      }
    });

    test('send alias works identically', () => {
      const socket = freshSocket();
      try {
        const { exitCode } = runCLI(['queue', 'send', 'deploy', 'v1'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        const dir = queueDir(socket, 'deploy');
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('v1');
      } finally {
        cleanup(socket);
      }
    });

    test('sequences multiple messages', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'ch', 'first'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'push', 'ch', 'second'], { env: { TMUX_SOCKET: socket } });
        const dir = queueDir(socket, 'ch');
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('first');
        expect(fs.readFileSync(`${dir}/msg.1`, 'utf-8')).toBe('second');
        expect(fs.readFileSync(`${dir}/next`, 'utf-8').trim()).toBe('2');
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('queue pop', () => {
    test('delivers pending messages in order, exactly once', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'ch', 'first'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'push', 'ch', 'second'], { env: { TMUX_SOCKET: socket } });

        const w1 = runCLI(['queue', 'pop', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(w1.exitCode).toBe(0);
        expect(w1.stdout).toBe('first');

        const w2 = runCLI(['queue', 'pop', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(w2.exitCode).toBe(0);
        expect(w2.stdout).toBe('second');

        // Both consumed: cursor advanced, message files removed.
        const dir = queueDir(socket, 'ch');
        expect(fs.readFileSync(`${dir}/cursor`, 'utf-8').trim()).toBe('1');
        expect(fs.existsSync(`${dir}/msg.0`)).toBe(false);
        expect(fs.existsSync(`${dir}/msg.1`)).toBe(false);
      } finally {
        cleanup(socket);
      }
    });

    test('pop --nowait exits 1 when queue is empty', () => {
      const socket = freshSocket();
      try {
        const res = runCLI(['queue', 'pop', 'empty-queue', '--nowait'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(res.exitCode).toBe(1);
      } finally {
        cleanup(socket);
      }
    });

    test('pop --timeout exits 2 on expiry', () => {
      const socket = freshSocket();
      try {
        const res = runCLI(['queue', 'pop', 'empty-queue', '--timeout', '1'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(res.exitCode).toBe(2);
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('queue peek', () => {
    test('inspects next message without advancing cursor or removing it', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'ch', 'peek-target'], { env: { TMUX_SOCKET: socket } });

        const p1 = runCLI(['queue', 'peek', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(p1.exitCode).toBe(0);
        expect(p1.stdout).toBe('peek-target');

        const p2 = runCLI(['queue', 'peek', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(p2.exitCode).toBe(0);
        expect(p2.stdout).toBe('peek-target');

        // Cursor should still be unadvanced and file still exists
        const dir = queueDir(socket, 'ch');
        expect(fs.existsSync(`${dir}/msg.0`)).toBe(true);
      } finally {
        cleanup(socket);
      }
    });

    test('peek on empty queue exits 1', () => {
      const socket = freshSocket();
      try {
        const res = runCLI(['queue', 'peek', 'empty-queue'], { env: { TMUX_SOCKET: socket } });
        expect(res.exitCode).toBe(1);
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('queue clear', () => {
    test('drains queue messages', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'ch', 'm1'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'push', 'ch', 'm2'], { env: { TMUX_SOCKET: socket } });

        const res = runCLI(['queue', 'clear', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(res.exitCode).toBe(0);

        const peek = runCLI(['queue', 'peek', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(peek.exitCode).toBe(1);
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('queue list', () => {
    test('reports pending counts per channel (plain)', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'alpha', 'a-message'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'push', 'alpha', 'another'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'push', 'beta', 'b-message'], { env: { TMUX_SOCKET: socket } });
        runCLI(['queue', 'pop', 'beta'], { env: { TMUX_SOCKET: socket } });

        const { exitCode, stdout } = runCLI(['queue', 'list'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/alpha\s+pending=2/);
        expect(stdout).toMatch(/beta\s+pending=0/);
        expect(stdout).toContain('a-message');
      } finally {
        cleanup(socket);
      }
    });

    test('reports structured JSON with --json', () => {
      const socket = freshSocket();
      try {
        runCLI(['queue', 'push', 'alpha', 'msg1'], { env: { TMUX_SOCKET: socket } });
        const { exitCode, stdout } = runCLI(['queue', 'list', '--json'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        const data = JSON.parse(stdout);
        expect(data).toEqual([
          {
            queue: 'alpha',
            pending: 1,
            cursor: -1,
            next: 1,
          },
        ]);
      } finally {
        cleanup(socket);
      }
    });

    test('reports no queues for an unused socket', () => {
      const socket = freshSocket();
      const plain = runCLI(['queue', 'list'], { env: { TMUX_SOCKET: socket } });
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain('No queues');

      const json = runCLI(['queue', 'list', '--json'], { env: { TMUX_SOCKET: socket } });
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
    });
  });

  describe('short alias q', () => {
    test('tmuxy q routes push, pop, list', () => {
      const socket = freshSocket();
      try {
        const pushRes = runCLI(['q', 'push', 'ch', 'val'], { env: { TMUX_SOCKET: socket } });
        expect(pushRes.exitCode).toBe(0);

        const listRes = runCLI(['q', 'list', '--json'], { env: { TMUX_SOCKET: socket } });
        expect(listRes.exitCode).toBe(0);
        expect(JSON.parse(listRes.stdout)[0].queue).toBe('ch');

        const popRes = runCLI(['q', 'pop', 'ch'], { env: { TMUX_SOCKET: socket } });
        expect(popRes.exitCode).toBe(0);
        expect(popRes.stdout).toBe('val');
      } finally {
        cleanup(socket);
      }
    });
  });

  describe('sequence allocation under contention', () => {
    test('concurrent pushes each get their own sequence, losing no message', async () => {
      const socket = freshSocket();
      const count = 16;
      try {
        const codes = await runCLIConcurrent(
          Array.from({ length: count }, (_, i) => ['queue', 'push', 'ch', `m${i}`]),
          { env: { TMUX_SOCKET: socket } },
        );
        expect(codes.every((c) => c === 0)).toBe(true);

        const dir = queueDir(socket, 'ch');
        const seqs = fs
          .readdirSync(dir)
          .filter((f) => /^msg\.\d+$/.test(f))
          .map((f) => Number(f.slice('msg.'.length)))
          .sort((a, b) => a - b);
        expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i));
        expect(fs.readFileSync(`${dir}/next`, 'utf-8').trim()).toBe(String(count));

        const payloads = seqs.map((n) => fs.readFileSync(`${dir}/msg.${n}`, 'utf-8'));
        expect([...new Set(payloads)].sort()).toEqual(
          Array.from({ length: count }, (_, i) => `m${i}`).sort(),
        );
        expect(fs.existsSync(`${dir}/.lock`)).toBe(false);
      } finally {
        cleanup(socket);
      }
    }, 30000);

    test('a lock left behind by a dead process is reclaimed, not waited on', () => {
      const socket = freshSocket();
      const dir = queueDir(socket, 'ch');
      try {
        const dead = reapedPid();
        fs.mkdirSync(`${dir}/.lock`, { recursive: true });
        fs.writeFileSync(`${dir}/.lock/pid`, String(dead));

        const { exitCode } = runCLI(['queue', 'push', 'ch', 'after-crash'], {
          env: { TMUX_SOCKET: socket },
        });
        expect(exitCode).toBe(0);
        expect(fs.readFileSync(`${dir}/msg.0`, 'utf-8')).toBe('after-crash');
      } finally {
        cleanup(socket);
      }
    }, 30000);
  });
});
