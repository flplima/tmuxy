const { runCLI } = require('./helpers/run-cli');

describe('CLI run escape hatch', () => {
  describe('basic routing', () => {
    test('routes arbitrary command through run-shell', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'swap-pane', '-s', '%0', '-t', '%1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux swap-pane -s %0 -t %1']);
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
      const { stdout, stderr, exitCode, tmuxCalls } = runCLI(['run', 'new-window']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted for safety');
      // Should use split-window + break-pane instead
      expect(tmuxCalls).toHaveLength(2);
      expect(tmuxCalls[0].args[0]).toBe('split-window');
      expect(tmuxCalls[1].args[0]).toBe('break-pane');
      expect(stdout.trim()).toBe('%99');
    });

    test('intercepts neww alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'neww']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted');
      expect(tmuxCalls).toHaveLength(2);
    });

    test('intercepts new-window with -n name', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'new-window', '-n', 'my-win']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[1].args[0]).toBe('break-pane');
      expect(tmuxCalls[1].args).toContain('-n');
      expect(tmuxCalls[1].args).toContain('my-win');
    });
  });

  describe('resize-window blocking', () => {
    test('blocks resize-window', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resize-window']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      expect(stderr).toContain('crashes tmux');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('blocks resizew alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resizew']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pass-through commands', () => {
    test('passes send-keys through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'send-keys', '-t', '%3', 'ls', 'Enter']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux send-keys -t %3 ls Enter']);
    });

    test('passes list-panes through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes']);
      expect(exitCode).toBe(0);
      // run_safe adds trailing space when no args: "tmux list-panes "
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(/^tmux list-panes\s*$/);
    });
  });
});
