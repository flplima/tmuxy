/**
 * `tmuxy pane group all` and `ungroup`: a whole tab's worth of group work,
 * composed from the one-pane verbs. The dispatcher hands the caller's pane to
 * `pane-group-tab` through run-shell; the script reads the tab from tmux and
 * hands each pane to `pane-group join` / `leave`, which the stub server
 * records.
 */

const { runCLI } = require('./helpers/run-cli');
const { runGroupTabScript } = require('./helpers/run-group-script');

describe('tmuxy pane group all / ungroup', () => {
  test.each(['all', 'ungroup'])('pane group %s runs pane-group-tab on the caller pane', (verb) => {
    const { tmuxCalls } = runCLI(['pane', 'group', verb], {
      env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%7' },
    });
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].target).toBe('%7');
    expect(tmuxCalls[0].args[1]).toContain(`pane-group-tab' ${verb} #{pane_id}`);
  });

  test('a pane named on the command line is the anchor', () => {
    const { tmuxCalls } = runCLI(['pane', 'group', 'all', '%4'], {
      env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%7' },
    });
    expect(tmuxCalls[0].args[1]).toContain("pane-group-tab' all '%4'");
  });

  test('all: every other pane in the tab joins the anchor, in tab order', () => {
    const { stdout, exitCode } = runGroupTabScript('all', ['%1'], {
      MOCK_TMUX_WINDOW_ID: '@2',
      MOCK_TMUX_LIST_PANES: '%0\n%1\n%5',
    });
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')).toEqual([
      expect.stringMatching(/^server group join %0 %1 /),
      expect.stringMatching(/^server group join %5 %1 /),
    ]);
  });

  test('all: a pane alone in its tab has nothing to gather', () => {
    const { stdout, exitCode } = runGroupTabScript('all', ['%1'], {
      MOCK_TMUX_WINDOW_ID: '@2',
      MOCK_TMUX_LIST_PANES: '%1',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('ungroup: each parked member comes back beside the anchor in group order, then the anchor leaves and the tab is tiled', () => {
    const { stdout, exitCode } = runGroupTabScript('ungroup', ['%1'], {
      MOCK_TMUX_WINDOW_ID: '@2',
      MOCK_TMUX_GROUP_ID: 'g3',
      MOCK_TMUX_LIST_PANES: '%9 g3 2\n%1 g3 0\n%4 g3 1\n%7 g8 0\n%2  ',
    });
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')).toEqual([
      expect.stringMatching(/^server group leave %4 --beside %1 right /),
      expect.stringMatching(/^server group leave %9 --beside %1 right /),
      expect.stringMatching(/^server group leave %1 --tab/),
    ]);
  });

  test('ungroup: a pane in no group is left alone', () => {
    const { stdout, exitCode } = runGroupTabScript('ungroup', ['%1'], { MOCK_TMUX_GROUP_ID: '' });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});
