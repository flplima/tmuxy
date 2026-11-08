const { runCLI } = require('./helpers/run-cli');

describe('CLI dispatch', () => {
  test('unknown command fails with error', () => {
    const { stderr, exitCode } = runCLI(['foobar', '--flag']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown command: foobar');
    expect(stderr).toContain('Usage: tmuxy <command>');
  });
});
