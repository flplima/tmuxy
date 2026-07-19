const { runCLI } = require('./helpers/run-cli');
const {
  LIST_WINDOWS_OUTPUT,
  LIST_WINDOWS_JSON,
  LIST_WINDOWS_WITH_HIDDEN_OUTPUT,
  LIST_WINDOWS_HOSTILE_OUTPUT,
} = require('./helpers/fixtures');

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

    test('--json excludes hidden windows (float/group/sidebar)', () => {
      const { stdout, exitCode } = runCLI(['tab', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_WINDOWS: LIST_WINDOWS_WITH_HIDDEN_OUTPUT },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      // Only the two real tabs survive; the float, group, and sidebar windows
      // are filtered out so the tree view never lists tmuxy's own chrome.
      expect(parsed).toEqual(LIST_WINDOWS_JSON);
    });

    test('--json survives a window name containing a comma and a quote', () => {
      // Window names are user-controlled (`tmuxy tab rename`). The old
      // comma-joined, unescaped serializer shifted every field after the name
      // and emitted unparseable JSON for a name like: build, "test"
      const { stdout, exitCode } = runCLI(['tab', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_WINDOWS: LIST_WINDOWS_HOSTILE_OUTPUT },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual([
        { id: '@0', index: 0, name: 'build, "test"', panes: 2, active: true },
      ]);
    });
  });

  describe('tab create', () => {
    test('creates tab (no name)', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'create']);
      expect(exitCode).toBe(0);
      // Routes through run-shell with a compound splitw+breakp command so
      // it doesn't crash tmux 3.5a when control mode is attached. The
      // set-option tags the new window as a managed tab so the frontend
      // picks it up on the next list-windows refresh.
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        'tmux -L tmuxy splitw \\; breakp \\; set-option -w @tmuxy-window-type tab',
      ]);
    });

    test('creates tab with name', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'create', 'my-tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw \\; breakp -n 'my-tab' \\; set-option -w @tmuxy-window-type tab",
      ]);
    });
  });

  describe('tab kill', () => {
    test('kills current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy kill-window']);
    });

    test('kills specific tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill', '@2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy kill-window -t '@2'"]);
    });
  });

  describe('tab select', () => {
    test('selects tab by index', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy select-window -t '2'"]);
    });

    test('selects tab by @id', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '@1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy select-window -t '@1'"]);
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
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy next-window']);
    });
  });

  describe('tab prev', () => {
    test('goes to previous tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'prev']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy previous-window']);
    });
  });

  describe('tab rename', () => {
    test('renames current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', 'new-name']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy rename-window 'new-name'"]);
    });

    test('errors with no name', () => {
      const { stderr, exitCode } = runCLI(['tab', 'rename']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('name required');
    });

    test('keeps a multi-word name in one argument', () => {
      // Previously run_safe flattened its args with $*, so the name reached
      // tmux as two bare words: the tab was renamed to "my" and the rest
      // became a stray argument.
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', 'my tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy rename-window 'my tab'",
      ]);
    });

    test('escapes quotes and doubles # in a name', () => {
      // A bare # is format-expanded by run-shell before the inner tmux sees
      // it (tmux 3.7a+), so it must be doubled.
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', "it's #1"]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy rename-window 'it'\\''s ##1'",
      ]);
    });
  });

  describe('tab layout', () => {
    test('defaults to next layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy next-layout']);
    });

    test('selects specific layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'even-h']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy select-layout 'even-h'"]);
    });

    test('uses next layout explicitly', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy next-layout']);
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
