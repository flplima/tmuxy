const { runCLI } = require('./helpers/run-cli');
const { LIST_WINDOWS_OUTPUT, LIST_WINDOWS_JSON } = require('./helpers/fixtures');

describe('CLI tab subcommands', () => {
  describe('tab list', () => {
    test('lists tabs (plain)', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'list']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('list-windows');
    });

    test('lists tabs --json', () => {
      const { stdout, exitCode } = runCLI(['tab', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_WINDOWS: LIST_WINDOWS_OUTPUT },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(LIST_WINDOWS_JSON);
    });
  });

  describe('tab create', () => {
    test('creates tab (no name)', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['tab', 'create']);
      expect(exitCode).toBe(0);
      // split-window first, then break-pane
      expect(tmuxCalls).toHaveLength(2);
      expect(tmuxCalls[0].args[0]).toBe('split-window');
      expect(tmuxCalls[0].args).toContain('-dP');
      expect(tmuxCalls[1].args[0]).toBe('break-pane');
      expect(tmuxCalls[1].args).toContain('-d');
      // stdout should contain the new pane id
      expect(stdout.trim()).toBe('%99');
    });

    test('creates tab with name', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'create', 'my-tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(2);
      expect(tmuxCalls[1].args[0]).toBe('break-pane');
      expect(tmuxCalls[1].args).toContain('-n');
      expect(tmuxCalls[1].args).toContain('my-tab');
    });
  });

  describe('tab kill', () => {
    test('kills current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux kill-window']);
    });

    test('kills specific tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill', '@2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux kill-window -t @2']);
    });
  });

  describe('tab select', () => {
    test('selects tab by index', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux select-window -t 2']);
    });

    test('selects tab by @id', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '@1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux select-window -t @1']);
    });

    test('errors with no argument', () => {
      const { stderr, exitCode } = runCLI(['tab', 'select']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('tab index or @id required');
    });
  });

  describe('tab next', () => {
    test('goes to next tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux next-window']);
    });
  });

  describe('tab prev', () => {
    test('goes to previous tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'prev']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux previous-window']);
    });
  });

  describe('tab rename', () => {
    test('renames current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', 'new-name']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux rename-window 'new-name'"]);
    });

    test('errors with no name', () => {
      const { stderr, exitCode } = runCLI(['tab', 'rename']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('name required');
    });
  });

  describe('tab layout', () => {
    test('defaults to next layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux next-layout']);
    });

    test('selects specific layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'even-h']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux select-layout even-h']);
    });

    test('uses next layout explicitly', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux next-layout']);
    });
  });

  describe('tab unknown', () => {
    test('errors on unknown tab subcommand', () => {
      const { stderr, exitCode } = runCLI(['tab', 'unknown']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown tab command: unknown');
      expect(stderr).toContain('Usage: tmuxy tab <command>');
    });
  });
});
