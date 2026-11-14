const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { SOCKET } = require('./helpers/env');
const {
  LIST_WINDOWS_OUTPUT,
  LIST_WINDOWS_JSON,
  LIST_WINDOWS_WITH_HIDDEN_OUTPUT,
  LIST_WINDOWS_HOSTILE_OUTPUT,
} = require('./helpers/fixtures');

const SCRIPTS_DIR = path.resolve(__dirname, '../../packages/tmuxy-cli/bin/tmuxy');

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

    test('--json excludes hidden windows (float/sidebar)', () => {
      const { stdout, exitCode } = runCLI(['tab', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_WINDOWS: LIST_WINDOWS_WITH_HIDDEN_OUTPUT },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
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

    // A name can hold any byte (`tmux rename-window $'\e[31mred'`): JSON
    // forbids a raw control character, so it is escaped, as a verb's answer
    // escapes it — the name comes back whole.
    test('--json keeps a window name holding a control character, escaped', () => {
      const { stdout, exitCode } = runCLI(['tab', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_WINDOWS: '@0\t0\t\x1b[31mred\t1\t1\ttab' },
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        { id: '@0', index: 0, name: '\x1b[31mred', panes: 1, active: true },
      ]);
    });
  });

  // The tab itself is the server binary's `new-tab` verb
  // (packages/tmuxy-verbs/src/run_cli.rs; the command list is tmuxy-core's
  // `tmux_command::NewTab`).
  describe('tab create', () => {
    test.each([
      [['tab', 'create'], 'new-tab --'],
      [['tab', 'create', 'my-tab'], 'new-tab -- my-tab'],
      [['tab', 'create', 'my-tab', '--json'], 'new-tab --json -- my-tab'],
    ])('%j hands the name to the new-tab verb', (args, verb) => {
      const { stdout, exitCode, tmuxCalls } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(0);
      expect(stdout.trim()).toBe(`mock-server-started ${verb}`);
    });

    test('a name that looks like a flag is a bad command line', () => {
      const { exitCode } = runCLI(['tab', 'create', '-x']);
      expect(exitCode).toBe(2);
    });
  });

  // A kill sweeps the stash in the same command list: the killed tab's
  // parked group members get no `pane-died`, and a `tab kill` of the
  // caller's own tab ends the CLI with it, so a second command never runs.
  describe('tab kill', () => {
    const GC = `run-shell 'bash ${SCRIPTS_DIR}/pane-group gc'`;

    test('kills current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} killw \\; ${GC}`]);
    });

    test('kills specific tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'kill', '@2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} killw -t '@2' \\; ${GC}`]);
    });
  });

  describe('tab select', () => {
    test('selects tab by index', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '2']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} select-window -t '2'`]);
    });

    test('selects tab by @id', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'select', '@1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} select-window -t '@1'`]);
    });

    test('errors with no argument', () => {
      const { stderr, exitCode } = runCLI(['tab', 'select']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('tab index, @id or name required');
    });
  });

  describe('tab next', () => {
    test('goes to next tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} next-window`]);
    });
  });

  describe('tab prev', () => {
    test('goes to previous tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'prev']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} previous-window`]);
    });
  });

  describe('tab rename', () => {
    test('renames current tab', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', 'new-name']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        `tmux -L ${SOCKET} rename-window 'new-name'`,
      ]);
    });

    test('errors with no name', () => {
      const { stderr, exitCode } = runCLI(['tab', 'rename']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('name required');
    });

    test('keeps a multi-word name in one argument', () => {
      // Previously run_safe flattened its args with $*, so the name reached
      // tmux as two bare words: the tab was renamed to "my" and the rest
      // became a stray argument.
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', 'my tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} rename-window 'my tab'`]);
    });

    test('escapes quotes and doubles # in a name', () => {
      // A bare # is format-expanded by run-shell before the inner tmux sees
      // it (tmux 3.7a+), so it must be doubled.
      const { exitCode, tmuxCalls } = runCLI(['tab', 'rename', "it's #1"]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        `tmux -L ${SOCKET} rename-window 'it'\\''s ##1'`,
      ]);
    });
  });

  describe('tab layout', () => {
    test('defaults to next layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} next-layout`]);
    });

    test('selects specific layout', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'even-h']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} select-layout 'even-h'`]);
    });

    test('uses next layout explicitly', () => {
      const { exitCode, tmuxCalls } = runCLI(['tab', 'layout', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${SOCKET} next-layout`]);
    });
  });

  describe('tab unknown', () => {
    test('errors on unknown tab subcommand', () => {
      const { stderr, exitCode } = runCLI(['tab', 'unknown']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown tab command: unknown');
      expect(stderr).toContain('Usage: tmuxy tab <command>');
    });
  });
});
