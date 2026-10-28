const { runCLI } = require('./helpers/run-cli');
const { LIST_PANES_OUTPUT, LIST_PANES_JSON } = require('./helpers/fixtures');

describe('CLI pane float', () => {
  describe('pane float', () => {
    // A float has to reach the UI as one step. The pane is born by splitting the
    // caller's pane, which puts it in the tab the user is looking at until
    // break-pane moves it out: if the split and the break are two tmux
    // invocations, every attached client renders the tab with an extra pane for
    // as long as the shell takes in between, and the float visibly "appears as a
    // split first". One command list is one command queue, so the client sees
    // both in the same batch of notifications and never paints the split.
    const floatEnv = {
      TMUX_SOCKET: 'tmuxy',
      TMUX_PANE: '%5',
      MOCK_TMUX_SESSION: 'main',
      MOCK_TMUX_WINDOW_ID: '@3',
      // The float window's only pane, as `display-message -p '#{pane_id}'`
      // answers for it.
      MOCK_TMUX_PANE_ID: '%99',
      // What `list-windows -F '#{window_index}'` answers: the session holds
      // windows 0 and 1, so 2 is the lowest index the float can claim.
      MOCK_TMUX_LIST_WINDOWS: '0\n1',
    };

    /**
     * SEC-24. `--width`, `--height` and `--bg` are interpolated into the
     * command STRING that `run-shell` hands to a shell, and tmux expands
     * `#(...)` in that string before the shell ever sees it. The values reach
     * this script from a client, so each is checked rather than trusted.
     */
    test.each([
      ['--width', '50; touch /tmp/pwned'],
      ['--width', '#(touch /tmp/pwned)'],
      ['--height', "12' ; touch /tmp/pwned ; '"],
      ['--bg', 'dim #(touch /tmp/pwned)'],
      ['--bg', 'sideways'],
    ])('refuses %s %j rather than splicing it into the command', (flag, value) => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'float', flag, value], { env: floatEnv });
      expect(exitCode).not.toBe(0);
      expect(tmuxCalls.filter((c) => c.args[0] === 'run-shell')).toHaveLength(0);
    });

    test('creates the float in a single tmux command list', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(
        ['pane', 'float', '--width', '50', '--height', '12'],
        { env: floatEnv },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('%99');

      const lists = tmuxCalls.filter((c) => c.args[0] === 'run-shell');
      expect(lists).toHaveLength(1);
      // The new window's index is named up front because break-pane never says
      // which window it made, and `set-option -w` with no target would tag the
      // window the user is looking at instead. The trailing select-pane hands
      // the caller's pane back: break-pane took the tab's active pane away.
      // The caller's pane rides along as the inner client's TMUX_PANE, like
      // every run-shell mutation (_run_safe in packages/tmuxy-cli/bin/tmuxy/_lib).
      expect(lists[0].args[1]).toBe(
        'TMUX_PANE=%5 tmux -L tmuxy split-window -t %5' +
          ' \\; break-pane -d -n float -t main:2' +
          ' \\; set-option -w -t main:2 @tmuxy-window-type float' +
          ' \\; set-option -w -t main:2 @tmuxy-float-parent @3' +
          ' \\; set-option -w -t main:2 @tmuxy-float-width 50' +
          ' \\; set-option -w -t main:2 @tmuxy-float-height 12' +
          ' \\; resize-pane -t main:2 -x 50' +
          ' \\; resize-pane -t main:2 -y 12' +
          ' \\; select-pane -t %5' +
          " \\; display-message -p -t main:2 '##{pane_id} ##{window_id}'",
      );
    });

    test('a float running a command closes its own window, never the caller tab', () => {
      // The command's float can close before the script asks tmux about it,
      // and display-message answers for a target that is gone with the
      // caller's pane: the float's ids come from the list that makes it, and
      // only its window id is closed. Here the caller's window is @3 (what
      // `#{window_id}` answers for the caller) and the float's is @98.
      const { exitCode, tmuxCalls } = runCLI(['pane', 'float', 'echo', 'hi'], {
        env: { ...floatEnv, MOCK_TMUX_FLOAT_WINDOW_ID: '@98', MOCK_TMUX_LIST_PANES: '4242' },
      });
      expect(exitCode).toBe(0);
      const kills = tmuxCalls.filter(
        (c) => c.args[0] === 'run-shell' && c.args[1].includes('kill-window'),
      );
      expect(kills).toHaveLength(1);
      expect(kills[0].args[1]).toContain('kill-window -t @98');
    });

    test('a bare float is 60x15 cells, and never taller than the tab', () => {
      // The default size is in cells, not a share of the window, and the height
      // is capped to the tab it floats over - a float with more rows than the
      // window has nowhere to put them.
      const bare = runCLI(['pane', 'float'], {
        env: { ...floatEnv, MOCK_TMUX_WINDOW_ROWS: '40' },
      });
      expect(bare.exitCode).toBe(0);
      const list = bare.tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1];
      expect(list).toContain('@tmuxy-float-width 60');
      expect(list).toContain('@tmuxy-float-height 15');

      const short = runCLI(['pane', 'float'], {
        env: { ...floatEnv, MOCK_TMUX_WINDOW_ROWS: '9' },
      });
      expect(short.exitCode).toBe(0);
      const shortList = short.tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1];
      expect(shortList).toContain('@tmuxy-float-height 9');
    });

    test('an explicit --height is taken as given, tall or not', () => {
      // Only the DEFAULT is capped. Asking for a float taller than the tab is
      // the caller's business, and tmux sizes the pane to what it can.
      const { exitCode, tmuxCalls } = runCLI(['pane', 'float', '--height', '80'], {
        env: { ...floatEnv, MOCK_TMUX_WINDOW_ROWS: '40' },
      });
      expect(exitCode).toBe(0);
      const list = tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1];
      expect(list).toContain('@tmuxy-float-height 80');
      // Width was not asked for and no drawer was named, so it stays unset.
      expect(list).not.toContain('@tmuxy-float-width');
    });

    test('a drawer float carries its direction and backdrop in the same list', () => {
      const { exitCode, tmuxCalls } = runCLI(
        ['pane', 'float', '--left', '--bg', 'blur', '--hide-header'],
        { env: floatEnv },
      );
      expect(exitCode).toBe(0);
      const list = tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1];
      expect(list).toContain('@tmuxy-float-drawer left');
      expect(list).toContain('@tmuxy-float-bg blur');
      expect(list).toContain('@tmuxy-float-noheader 1');
      expect(list.indexOf('split-window')).toBeLessThan(list.indexOf('break-pane'));
    });
  });
});
