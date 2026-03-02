const { runCLI } = require('./helpers/run-cli');

describe('CLI widget subcommands', () => {
  // Widget exec paths (image, markdown) use `exec` to replace the process with
  // tmuxy-widget-image/markdown scripts that have `trap 'exec bash </dev/tty' EXIT`,
  // which fails without a tty. We test only help and missing-arg error cases.

  describe('widget image', () => {
    test('shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'image', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget image');
    });

    test('errors with no source', () => {
      const { stderr, exitCode } = runCLI(['widget', 'image']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('image source required');
    });
  });

  describe('widget markdown', () => {
    test('shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'markdown', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget markdown');
    });

    test('errors with no file', () => {
      const { stderr, exitCode } = runCLI(['widget', 'markdown']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('file or - required');
    });

    test('md alias shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'md', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget markdown');
    });

    test('md alias errors with no file', () => {
      const { stderr, exitCode } = runCLI(['widget', 'md']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('file or - required');
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
