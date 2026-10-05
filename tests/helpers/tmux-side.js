/**
 * What tmux itself holds for a page's session, for failure messages.
 */

const { execFileSync } = require('child_process');
const { tmuxExec } = require('./tmux-socket');

/**
 * What tmux itself holds for the page's session, for a failure message: each
 * pane's own screen, whether it is dead, and its process's state. A prompt on
 * tmux's screen but not in the client is a delivery fault; an empty tmux
 * screen with the shell asleep in the kernel is a shell that never started
 * talking. Never throws — it is only ever read on the way to a failure.
 */
async function tmuxSideOfSession(page, sessionName = null) {
  try {
    const session =
      sessionName ?? (await page.evaluate(() => window.app?.getSnapshot()?.context?.sessionName));
    if (!session) return 'tmux: (the client names no session)';
    const panes = tmuxExec(
      `list-panes -s -t '${session}' -F '#{pane_id} pid=#{pane_pid} dead=#{pane_dead} cmd=#{pane_current_command} size=#{pane_width}x#{pane_height}'`,
    )
      .split('\n')
      .filter(Boolean);
    const lines = panes.map((row) => {
      const id = row.split(' ')[0];
      const pid = (row.match(/pid=(\d+)/) || [])[1];
      const screen = tmuxExec(`capture-pane -p -t '${id}'`).trim().slice(-160);
      let proc = '';
      try {
        proc = execFileSync('ps', ['-o', 'pid=,stat=,wchan=,args=', '-p', pid], {
          encoding: 'utf8',
        }).trim();
      } catch {
        proc = '(no such process)';
      }
      return `  ${row}\n    process: ${proc}\n    tmux screen: ${JSON.stringify(screen)}`;
    });
    return `tmux side of ${session}:\n${lines.join('\n')}`;
  } catch (error) {
    return `tmux side: unreadable (${error.message.split('\n')[0]})`;
  }
}

module.exports = { tmuxSideOfSession };
