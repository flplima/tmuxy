const { runCLI } = require('./helpers/run-cli');

describe('CLI session commands', () => {
  describe('session help', () => {
    test.each([
      [['session'], 'Usage: tmuxy session <command>'],
      [['session', '--help'], 'Usage: tmuxy session <command>'],
      [['session', '-h'], 'Usage: tmuxy session <command>'],
    ])('tmuxy %j shows session usage', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('session subcommand help', () => {
    test.each([
      [['session', 'switch', '--help'], 'Usage: tmuxy session switch'],
      [['session', 'switch', '-h'], 'Usage: tmuxy session switch'],
      [['session', 'connect', '--help'], 'Usage: tmuxy session connect'],
      [['session', 'connect', '-h'], 'Usage: tmuxy session connect'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('session connect --web', () => {
    test('shows not-supported message', () => {
      const { stdout, exitCode } = runCLI(['session', 'connect', '--web']);
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        'SSH connections are only available in the Tauri desktop app',
      );
    });
  });

  describe('unknown session subcommand', () => {
    test('shows error and usage', () => {
      const { stderr, exitCode } = runCLI(['session', 'unknown']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown session command');
    });
  });

  describe('top-level help includes session', () => {
    test('session listed in top-level help', () => {
      const { stdout } = runCLI(['--help']);
      expect(stdout).toContain('session');
    });
  });
});
