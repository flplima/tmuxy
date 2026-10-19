const { runCLI } = require('./helpers/run-cli');

describe('CLI widget subcommands', () => {
  // The widget exec path uses `exec` to replace the process with a widget
  // script, which pipes into tmuxy-widget's `trap 'exec bash </dev/tty' EXIT`
  // — that fails without a tty. We test only help and error cases.

  describe('widget unknown', () => {
    test('errors on unknown widget subcommand', () => {
      const { stderr, exitCode } = runCLI(['widget', 'badcmd']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown widget command: badcmd');
      expect(stderr).toContain('Usage: tmuxy widget <command>');
    });
  });
});
