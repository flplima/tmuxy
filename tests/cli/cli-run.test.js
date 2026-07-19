const { runCLI } = require('./helpers/run-cli');

describe('CLI run escape hatch', () => {
  describe('basic routing', () => {
    test('routes arbitrary command through run-shell', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'swap-pane', '-s', '%0', '-t', '%1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy swap-pane '-s' '%0' '-t' '%1'"]);
    });

    test('errors with no command', () => {
      const { stderr, exitCode } = runCLI(['run']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('tmux command required');
      expect(stderr).toContain('Usage: tmuxy run <tmux-command>');
    });
  });

  describe('new-window interception', () => {
    test('intercepts new-window and uses safe alternative', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'new-window']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted for safety');
      // Routes through run-shell as a single atomic splitw+breakp+tag command
      // list (mirrors `tmuxy tab create`) — never a direct external tmux
      // invocation, which would crash tmux 3.5a with control mode attached.
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        'tmux -L tmuxy splitw \\; breakp \\; set-option -w @tmuxy-window-type tab',
      ]);
    });

    test('intercepts neww alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'neww']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted');
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        'tmux -L tmuxy splitw \\; breakp \\; set-option -w @tmuxy-window-type tab',
      ]);
    });

    test('intercepts new-window with -n name', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'new-window', '-n', 'my-win']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw \\; breakp -n 'my-win' \\; set-option -w @tmuxy-window-type tab",
      ]);
    });
  });

  describe('resize-window blocking', () => {
    test('blocks resize-window', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resize-window']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      // Wording matches docs/TMUX.md: externally-sent resize-window is
      // ignored, not a crash — the group scripts issue it from run-shell.
      expect(stderr).toContain('unreliable with control mode');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('blocks resizew alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resizew']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('argument quoting', () => {
    test('keeps an argument containing spaces intact', () => {
      // run_safe used to interpolate $* into the run-shell string, so
      // `rename-window "my tab"` reached tmux as two separate words.
      const { exitCode, tmuxCalls } = runCLI(['run', 'rename-window', 'my tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy rename-window 'my tab'",
      ]);
    });

    test('doubles # so run-shell does not format-expand it', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'rename-window', '#{pane_id}']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy rename-window '##{pane_id}'",
      ]);
    });
  });

  describe('pass-through commands', () => {
    test('passes send-keys through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'send-keys', '-t', '%3', 'ls', 'Enter']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy send-keys '-t' '%3' 'ls' 'Enter'"]);
    });

    test('passes list-panes through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes']);
      expect(exitCode).toBe(0);
      // run_safe adds trailing space when no args: "tmux -L tmuxy list-panes "
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(/^tmux -L tmuxy list-panes\s*$/);
    });
  });
});
