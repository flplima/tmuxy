const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy run` hands its words to the server binary's `run` verb, untouched.
 * What runs and what is refused is tmuxy-core's routing policy
 * (`command_router::route_cli_run` and its tests); how the command reaches
 * tmux through run-shell is the verb's (`packages/tmuxy-verbs/src/run_cli.rs`).
 * Here, the mock server prints the command line it was given.
 */
describe('tmuxy run', () => {
  test.each([
    [['run', 'swap-pane', '-s', '%0', '-t', '%1'], 'run -- swap-pane -s %0 -t %1'],
    [['run', 'list-panes -F "#{pane_id}"'], 'run -- list-panes -F "#{pane_id}"'],
    [['run', 'send-keys', '-t', '%3', 'id'], 'run -- send-keys -t %3 id'],
    [['run', 'kill-session', '-t', 'x', '--json'], 'run --json -- kill-session -t x'],
    [['run'], 'run --'],
  ])('%j reaches the run verb as written', (args, verb) => {
    const { stdout, exitCode, tmuxCalls } = runCLI(args);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(0);
    expect(stdout.trim()).toBe(`mock-server-started ${verb}`);
  });
});
