const { runCLI } = require('./helpers/run-cli');

// `nav`, `nav --help` and `nav -h` printing the usage are cli-help.test.js.
describe('CLI nav subcommand', () => {
  test('help lists all directions', () => {
    const { stdout } = runCLI(['nav', '--help']);
    for (const direction of ['left', 'right', 'up', 'down', 'next', 'prev']) {
      expect(stdout).toContain(direction);
    }
  });

  // Every direction goes to the nav script through run-shell, naming the
  // calling pane, so the script acts on the pane the key was pressed in.
  test.each(['left', 'right', 'up', 'down', 'next', 'prev'])(
    '%s dispatches run-shell with nav %s for the calling pane',
    (direction) => {
      const { exitCode, tmuxCalls } = runCLI(['nav', direction]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(new RegExp(`/nav' ${direction}\\b`));
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    },
  );

  test('an unknown direction is refused, with the usage, and reaches tmux not at all', () => {
    const { stderr, exitCode, tmuxCalls } = runCLI(['nav', 'diagonal']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown direction: diagonal');
    expect(stderr).toContain('Usage: tmuxy nav <direction>');
    expect(tmuxCalls).toHaveLength(0);
  });
});
