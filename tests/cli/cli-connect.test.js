const { runCLI } = require('./helpers/run-cli');

describe('CLI connect subcommand', () => {
  test('publishes TMUXY_CONNECT_TO/_SESSION via run-shell (explicit session)', () => {
    // Explicit session skips the target-socket `list-sessions` probe (which is
    // legitimately a DIFFERENT socket and would trip the harness's dedicated-
    // socket invariant), leaving just the two env-set publishes.
    const { exitCode, tmuxCalls } = runCLI(['connect', 'default', 'work']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0].args).toEqual([
      'run-shell',
      "tmux -L tmuxy set-environment -g TMUXY_CONNECT_TO 'default'",
    ]);
    expect(tmuxCalls[1].args).toEqual([
      'run-shell',
      "tmux -L tmuxy set-environment -g TMUXY_CONNECT_SESSION 'work'",
    ]);
  });

  test('--help documents both the form and the reconnect', () => {
    const { stdout } = runCLI(['connect', '--help']);
    expect(stdout).toContain('reconnects the tmuxy DESKTOP APP');
    expect(stdout).toContain('add a server');
  });

  test('no arguments launches the add-a-server form', () => {
    // The real form is a TUI; tests/cli/mocks/tmuxy-connect stands in for it
    // (found on PATH ahead of the real binary), proving the dispatch reached it.
    const { exitCode, stdout, tmuxCalls } = runCLI(['connect']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-connect-form');
    // Opening the form is purely local (servers.json); it issues no tmux calls.
    expect(tmuxCalls).toHaveLength(0);
  });
});
