const { runCLI } = require('./helpers/run-cli');

describe('CLI widget subcommands', () => {
  // The widget exec path uses `exec` to replace the process with
  // tmuxy-widget-browser, which pipes into tmuxy-widget's `trap 'exec bash
  // </dev/tty' EXIT` — that fails without a tty. We test only help and
  // missing-arg error cases.

  describe('widget browser', () => {
    test('shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'browser', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget browser');
    });

    test('errors with no source', () => {
      const { stderr, exitCode } = runCLI(['widget', 'browser']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('file, url or - required');
    });

    test('web alias shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'web', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget browser');
    });

    test('errors on a file that does not exist', () => {
      const { stderr, exitCode } = runCLI(['widget', 'browser', '/tmp/tmuxy-no-such-file.html']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('File not found');
    });
  });

  describe('widget unknown', () => {
    test('errors on unknown widget subcommand', () => {
      const { stderr, exitCode } = runCLI(['widget', 'badcmd']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown widget command: badcmd');
      expect(stderr).toContain('Usage: tmuxy widget <command>');
    });
  });
});
