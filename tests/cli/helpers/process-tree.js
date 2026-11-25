/**
 * A child a CLI test leaves running, and the way to end it: `stop()` resolves
 * once it and everything it started has exited, so what they write into (a
 * scratch directory) can be removed.
 */

const { spawn, spawnSync } = require('child_process');
const { sealedEnv } = require('./env');

/**
 * A pipe every process of the tree inherits, whatever session or process
 * group it moves to, and none of the CLI's scripts redirects: it closes when
 * the last of them has exited.
 */
const ALIVE_FD = 9;
/** How long `stop()` waits for the tree to exit before it fails. */
const EXIT_MS = 15000;

/** Every process on the machine: `{ pid, ppid, line }`. */
function processes() {
  const { stdout } = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], {
    env: sealedEnv(),
    encoding: 'utf8',
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid, line: line.trim() };
    });
}

/** `pids`, and the pid of every process descended from one of them. */
function withDescendants(pids, table) {
  const tree = new Set(pids);
  let size = 0;
  while (tree.size > size) {
    size = tree.size;
    for (const { pid, ppid } of table) if (tree.has(ppid)) tree.add(pid);
  }
  return tree;
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Start `command` in a process group of its own, its output piped.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env - From `scriptEnv()` or `sealedEnv()`
 * @returns {{ child: import('child_process').ChildProcess, stop: () => Promise<void> }}
 */
function startTree(command, args, env) {
  const stdio = Array(ALIVE_FD + 1).fill('ignore');
  stdio[1] = stdio[2] = stdio[ALIVE_FD] = 'pipe';
  const child = spawn(command, args, { detached: true, stdio, env });
  const alive = child.stdio[ALIVE_FD];
  const gone = new Promise((resolve) => alive.once('close', resolve));
  alive.resume();
  return {
    child,
    /**
     * Kill the child's process group and wait for the whole tree to exit.
     * Rejects, naming them, if processes are left after `EXIT_MS`.
     */
    async stop() {
      if (alive.closed) return;
      // Taken now: a process whose parent has exited is no longer its child.
      const started = withDescendants([child.pid], processes());
      kill(-child.pid);
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(resolve, EXIT_MS, true);
      });
      const timedOut = await Promise.race([gone, late]);
      clearTimeout(timer);
      if (!timedOut) return;
      const table = processes();
      const tree = withDescendants(started, table);
      const left = table.filter(({ pid }) => tree.has(pid));
      for (const { pid } of left) kill(pid);
      alive.destroy();
      throw new Error(
        `${command} ${args.join(' ')}: still running ${EXIT_MS}ms after it was killed:\n` +
          (left.map(({ line }) => line).join('\n') || '(a process that left the tree)'),
      );
    },
  };
}

module.exports = { startTree };
