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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux splitw']);
    });

    test('-h is interpreted as help (ambiguous with horizontal)', () => {
      // In the CLI, -h is the help flag — to split horizontally, use: pane split -h
      // But the for-loop over args catches -h as help before it reaches tmux
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'split', '-h']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy pane split');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('splits pane -v (vertical)', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split', '-v']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux splitw -v']);
    });
  });

  describe('pane kill', () => {
    test('kills current pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux killp']);
    });

    test('kills specific pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill', '%5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux killp -t %5']);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux ${expected}`]);
    });

    test('selects pane by ID', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'select', '%3']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux selectp -t %3']);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux resizep -U']);
    });

    test('resizes pane with count', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'resize', '-D', '5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux resizep -D 5']);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux swap-pane -s %0 -t %1']);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux resizep -Z']);
    });
  });

  describe('pane break', () => {
    test('breaks pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'break']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux breakp']);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux send-keys ls Enter']);
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
      expect(tmuxCalls[1].args).toEqual(['run-shell', 'tmux pasteb']);
    });

    test('errors with no text', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'paste']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('text required');
      expect(tmuxCalls).toHaveLength(0);
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
