/**
 * The server's control-mode monitor, seen from tmux.
 */

const { waitForCondition } = require('./browser');
const { tmuxExec } = require('./tmux-socket');

/** The clients tmux has attached to `session`; none once it is gone. */
function clientsOf(session) {
  try {
    tmuxExec(`has-session -t ${session} 2>/dev/null`, { timeout: 2000 });
    return tmuxExec(`list-clients -t ${session} -F '#{client_name}' 2>/dev/null`, {
      timeout: 2000,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Wait until the server's monitor for `session` has let go of tmux. It
 * attaches as a control-mode client, so tmux says when it is gone: no client
 * is left on the session (or the session itself is gone).
 */
async function waitForMonitorGone(session, timeout = 10000) {
  if (!session) return;
  await waitForCondition(
    null,
    () => clientsOf(session).length === 0,
    timeout,
    () => `the server to detach from ${session} (clients: ${clientsOf(session).join(', ')})`,
  );
}

/** Wait until the server's monitor has attached to `session` as a tmux client. */
async function waitForMonitorAttached(session, timeout = 30000) {
  await waitForCondition(
    null,
    () => clientsOf(session).length > 0,
    timeout,
    `the server to attach to ${session}`,
  );
}

module.exports = { waitForMonitorGone, waitForMonitorAttached };
