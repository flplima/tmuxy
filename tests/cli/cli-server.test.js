const { runCLI } = require('./helpers/run-cli');

describe('CLI server command', () => {
  // The mock tmuxy-server is in the mocks dir, which is prepended to PATH.
  test('finds tmuxy-server on PATH and execs it with its arguments', () => {
    const { stdout, exitCode } = runCLI(['server', '--port', '8080']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('8080');
  });
});
