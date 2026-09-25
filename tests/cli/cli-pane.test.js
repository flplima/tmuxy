const { runCLI } = require('./helpers/run-cli');
const { LIST_PANES_OUTPUT, LIST_PANES_JSON } = require('./helpers/fixtures');

describe('CLI pane subcommands', () => {
  describe('pane list', () => {
    test('lists panes (plain)', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('list-panes');
    });

    test('lists panes --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_PANES: LIST_PANES_OUTPUT },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(LIST_PANES_JSON);
    });

    test('lists panes --all passes -s flag', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'list', '--all']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toContain('-s');
    });

    test('lists panes --all --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list', '--all', '--json'], {
        env: { MOCK_TMUX_LIST_PANES: LIST_PANES_OUTPUT },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toContain('-s');
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(LIST_PANES_JSON);
    });
  });

  describe('pane split', () => {
    test('splits pane (default vertical)', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy splitw -P -F '##{pane_id}'"]);
    });

    test('splits pane -h (horizontal), not help', () => {
      // -h is this command's own flag. It used to be swallowed by the shared
      // `--help|-h` case, so the documented horizontal split printed usage and
      // did nothing.
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split', '-h']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -h -P -F '##{pane_id}'",
      ]);
    });

    test('--help still prints usage without splitting', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'split', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy pane split');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('splits pane -v (vertical)', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split', '-v']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -v -P -F '##{pane_id}'",
      ]);
    });

    test('splits pane --json outputs paneId JSON', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'split', '-h', '--json']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -h -P -F '##{pane_id}'",
      ]);
      expect(JSON.parse(stdout)).toHaveProperty('paneId');
    });
  });

  describe('pane kill', () => {
    test('kills current pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy killp']);
    });

    test('kills specific pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill', '%5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy killp -t '%5'"]);
    });
  });

  describe('pane select', () => {
    test.each([
      ['-U', 'selectp -U'],
      ['-D', 'selectp -D'],
      ['-L', 'selectp -L'],
      ['-R', 'selectp -R'],
    ])('selects pane %s', (dir, expected) => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'select', dir]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L tmuxy ${expected}`]);
    });

    test('selects pane by ID', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'select', '%3']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy selectp -t '%3'"]);
    });

    test('errors with no argument', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'select']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('pane direction or ID required');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('errors with invalid argument', () => {
      const { stderr, exitCode } = runCLI(['pane', 'select', 'badarg']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("invalid argument 'badarg'");
    });
  });

  describe('pane resize', () => {
    test('resizes pane in direction', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'resize', '-U']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -U']);
    });

    test('resizes pane with count', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'resize', '-D', '5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -D 5']);
    });

    test('errors with no direction', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'resize']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('direction required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pane swap', () => {
    test('swaps two panes', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'swap', '%0', '%1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy swap-pane -s '%0' -t '%1'"]);
    });

    test('errors with missing arguments', () => {
      const { stderr, exitCode } = runCLI(['pane', 'swap']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane zoom', () => {
    test('toggles zoom', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'zoom']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -Z']);
    });
  });

  describe('pane break', () => {
    test('breaks pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'break']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy breakp']);
    });
  });

  describe('pane capture', () => {
    test('captures current pane (plain)', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'capture'], {
        env: { MOCK_TMUX_CAPTURE: 'hello world' },
      });
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('hello world');
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toContain('capture-pane');
    });

    test('captures specific pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'capture', '%5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%5']);
    });

    test('captures with --json', () => {
      const { stdout, exitCode } = runCLI(['pane', 'capture', '--json'], {
        env: { MOCK_TMUX_CAPTURE: 'test content' },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ content: 'test content' });
    });

    test('captures specific pane with --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'capture', '%2', '--json'], {
        env: { MOCK_TMUX_CAPTURE: 'pane 2 content' },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%2']);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ content: 'pane 2 content' });
    });
  });

  describe('pane send', () => {
    test('sends keys', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'send', 'ls', 'Enter']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy send-keys 'ls' 'Enter'"]);
    });

    test('errors with no keys', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'send']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('keys required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pane paste', () => {
    test('pastes text', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'paste', 'hello world']);
      expect(exitCode).toBe(0);
      // load-buffer first, then run-shell pasteb
      expect(tmuxCalls).toHaveLength(2);
      expect(tmuxCalls[0].args).toEqual(['load-buffer', '-']);
      expect(tmuxCalls[1].args).toEqual(['run-shell', 'tmux -L tmuxy pasteb']);
    });

    test('errors with no text', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'paste']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('text required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

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
      expect(lists[0].args[1]).toBe(
        'tmux -L tmuxy split-window -t %5' +
          ' \\; break-pane -d -n float -t main:2' +
          ' \\; set-option -w -t main:2 @tmuxy-window-type float' +
          ' \\; set-option -w -t main:2 @tmuxy-float-parent @3' +
          ' \\; set-option -w -t main:2 @tmuxy-float-width 50' +
          ' \\; set-option -w -t main:2 @tmuxy-float-height 12' +
          ' \\; resize-pane -t main:2 -x 50' +
          ' \\; resize-pane -t main:2 -y 12' +
          ' \\; select-pane -t %5',
      );
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

  describe('pane unknown', () => {
    test('errors on unknown pane subcommand', () => {
      const { stderr, exitCode } = runCLI(['pane', 'unknown']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown pane command: unknown');
      expect(stderr).toContain('Usage: tmuxy pane <command>');
    });
  });
});
