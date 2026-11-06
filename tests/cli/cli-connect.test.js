const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy connect` and `tmuxy session connect` hand their arguments to the
 * server binary's `connect` and `session-connect` verbs
 * (`packages/tmuxy-verbs/src/connect_cli.rs`): the checks, the stages and the
 * request are theirs, tested against a real tmux and a stand-in ssh in
 * `packages/tmuxy-server/tests/cli_verbs.rs`. The mock server prints the
 * command line it was given.
 */
describe('tmuxy connect', () => {
  test.each([
    [['connect', 'default', 'work'], 'connect --socket default --session work'],
    [['connect', 'default'], 'connect --socket default'],
    [['connect', '/tmp/x', '--json'], 'connect --json --socket /tmp/x'],
    [['connect'], 'session-connect'],
    [['session', 'connect'], 'session-connect'],
    [
      ['session', 'connect', 'felipe@prod', '--socket', 'work', '--json'],
      'session-connect --json felipe@prod --socket work',
    ],
    [['session', 'connect', '--help'], 'session-connect --help'],
  ])('%j reaches the verb as written', (args, verb) => {
    const { exitCode, stdout, tmuxCalls } = runCLI(args);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(0);
    expect(stdout.trim()).toBe(`mock-server-started ${verb}`);
  });

  test('--help documents both the connect flow and the reconnect', () => {
    const { stdout } = runCLI(['connect', '--help']);
    expect(stdout).toContain('reconnects the tmuxy DESKTOP APP');
    expect(stdout).toContain('runs `tmuxy session connect`');
  });
});
