/**
 * The server's control-mode monitor, seen from tmux.
 */

const { delay } = require('./browser');
const { DELAYS } = require('./config');
const { tmuxExec } = require('./tmux-socket');

/**
 * Wait until the server's monitor for `session` has let go of tmux.
 *
 * The monitor attaches to tmux as a control-mode client, so tmux itself says
 * when it is gone: the session disappears (the test killed it) and no client
 * remains for it. This replaced a flat `delay(4000)` in every teardown — ~6.5
 * minutes of pure sleep across the suite, and a coupling that let one test's
 * slow shutdown fail the next one.
 */
async function waitForMonitorGone(session, timeout = 10000) {
  // No session was ever created, so no monitor attached to let go of.
  if (!session) return;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let clients = '';
    try {
      // A throw means "no such session", which is the state being waited for.
      tmuxExec(`has-session -t ${session} 2>/dev/null`, { timeout: 2000 });
      clients = tmuxExec(`list-clients -t ${session} -F '#{client_name}' 2>/dev/null`, {
        timeout: 2000,
      });
    } catch {
      clients = '';
    }
    if (clients.trim() === '') {
      // The server drops the monitor a beat after its last client leaves;
      // give that its grace period before the next test connects.
      await delay(DELAYS.LONG);
      return;
    }
    await delay(100);
  }
}

module.exports = { waitForMonitorGone };
