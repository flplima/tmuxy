/**
 * Following up on a torn-down pane: the shell may still be in the kernel.
 *
 * tmux closes a pane's PTY master immediately after signalling the shell. A
 * shell still inside its own start-up has not yet finished opening its
 * controlling terminal, and that open never returns once the master is gone —
 * the process sleeps in the kernel forever, reparented to pid 1, holding a PTY
 * slave. Run the suite enough times and the machine cannot open a terminal at
 * all. `bin/tmuxy/reap-orphan-shells` is the same job for a whole machine; this
 * is the targeted version, for pids a test knows it is responsible for.
 */

const { execFileSync } = require('child_process');

/** Whether a pid is alive, without signalling it. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive but not ours — which, for a pane's own shell, cannot
    // happen; treat it as alive and leave it alone.
    return err.code === 'EPERM';
  }
}

/** A pid's parent, or 0 when it cannot be read. */
function parentOf(pid) {
  try {
    return (
      parseInt(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' }).trim(),
        10,
      ) || 0
    );
  } catch {
    return 0;
  }
}

/**
 * SIGKILL any of `pids` still alive and adopted by pid 1.
 *
 * Still having its real parent means it is exiting in good order and will be
 * reaped; pid 1 as the parent after the session is gone means nothing is going
 * to signal it again. SIGKILL is the only signal that lands on a process
 * blocked in an uninterruptible open().
 *
 * @param {number[]} pids
 * @returns {number} how many were killed
 */
function reapPids(pids) {
  let killed = 0;
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    if (parentOf(pid) !== 1) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Gone between the check and the signal — the outcome we wanted
    }
  }
  return killed;
}

module.exports = { reapPids };
