const { runCLI } = require('./helpers/run-cli');

describe('CLI server command', () => {
  test('finds tmuxy-server in PATH and execs it', () => {
    // The mock tmuxy-server is in the mocks dir which is prepended to PATH
    const { stdout, exitCode } = runCLI(['server']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
  });

  test('passes arguments to server', () => {
    const { stdout, exitCode } = runCLI(['server', '--port', '8080']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('8080');
  });
});
