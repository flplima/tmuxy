const { runCLI } = require('./helpers/run-cli');

describe('CLI dispatch', () => {
  test('no args shows usage', () => {
    const { stdout, exitCode } = runCLI([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy <command>');
    expect(stdout).toContain('pane');
    expect(stdout).toContain('tab');
    expect(stdout).toContain('nav');
    expect(stdout).toContain('widget');
    expect(stdout).toContain('run');
    expect(stdout).toContain('server');
  });

  // `--help`, `-h` and every subcommand's own usage are cli-help.test.js.
  test('unknown command fails with error', () => {
    const { stderr, exitCode } = runCLI(['foobar', '--flag']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command: foobar');
    expect(stderr).toContain('Usage: tmuxy <command>');
  });
});
