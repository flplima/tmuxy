/**
 * `tmuxy plugin …`, a plugin's own `tmuxy plugin <verb>` included.
 *
 * The CLI owns the routing: `action` creates panes, so it runs inside
 * `run-shell` with the caller's pane as its target; every other verb is the
 * binary's, run as a plain process so the install gate can ask on the
 * terminal. What the verbs do is Rust (`tmuxy_core::plugins`, and
 * `packages/tmuxy-server/tests/plugin_install.rs` end to end).
 */

const { runCLI } = require('./helpers/run-cli');

const IN_PANE_7 = { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%7' };

describe('tmuxy plugin', () => {
  test('with no verb it prints its usage', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['plugin']);
    expect(exitCode).toBe(0);
    for (const verb of ['install', 'list', 'update', 'remove', 'action', 'log', 'check', 'new']) {
      expect(stdout).toContain(verb);
    }
    expect(stdout).toContain('unsandboxed');
    expect(tmuxCalls).toHaveLength(0);
  });

  /** The gate asks on the terminal, which a `run-shell` job has none of. */
  test('install, list and the rest run the binary directly, never through run-shell', () => {
    const install = runCLI(['plugin', 'install', 'someone/tmuxy-x', '--yes', '--sha', 'abc']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain(
      'mock-server-started plugin install someone/tmuxy-x --yes --sha abc',
    );
    expect(install.tmuxCalls).toHaveLength(0);

    const list = runCLI(['plugin', 'list', '--json']);
    expect(list.stdout).toContain('mock-server-started plugin list --json');
  });

  test('action runs inside tmux, aimed at the caller’s pane', () => {
    const { exitCode, tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open'], {
      env: IN_PANE_7,
    });
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].args[0]).toBe('run-shell');
    expect(tmuxCalls[0].args[1]).toMatch(
      /tmuxy-server'? 'plugin' 'action' '--pane' '%7' 'devtools:open'$/,
    );
  });

  test('a pane the caller names is the one used', () => {
    const { tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open', '--pane', '%3'], {
      env: IN_PANE_7,
    });
    expect(tmuxCalls[0].args[1]).toMatch(/'plugin' 'action' 'devtools:open' '--pane' '%3'$/);
    expect(tmuxCalls[0].args[1]).not.toContain('%7');
  });

  /** After `--` everything is the command's, `--pane` included. */
  test('arguments after -- reach the command untouched', () => {
    const { tmuxCalls } = runCLI(['plugin', 'action', 'devtools:open', '--', '--pane', "it's #1"], {
      env: IN_PANE_7,
    });
    expect(tmuxCalls[0].args[1]).toMatch(
      /'--pane' '%7' 'devtools:open' '--' '--pane' 'it'\\''s ##1'$/,
    );
  });
});

describe('a plugin verb', () => {
  /** `tmuxy plugin <verb>`: the binary tells its own commands from a plugin's. */
  test('runs through the binary as `plugin <verb>`, with its arguments, outside tmux', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['plugin', 'artifact', 'get', '--out', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started plugin artifact get --out x');
    expect(tmuxCalls).toHaveLength(0);
  });

  /** A plugin owns nothing at the top level: every top-level word is tmuxy's. */
  test('is not a top-level command', () => {
    const { stderr, stdout, exitCode } = runCLI(['artifact']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown command: artifact');
    expect(stdout).not.toContain('mock-server-started');
  });
});
