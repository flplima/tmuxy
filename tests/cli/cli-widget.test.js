const path = require('path');
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

  // A preview reads the file it was opened on and nothing else, so what it
  // will not open is refused before any pane option is written.
  describe('preview (tmuxy open)', () => {
    test.each([['open'], ['widget', 'preview']])('%s --help describes the flags', (...cmd) => {
      const { stdout, exitCode, tmuxCalls } = runCLI([...cmd, '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy-widget-preview [--net] [--no-theme] [file]');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses a file that is not a page or a markdown document', () => {
      const notAPage = path.resolve(__dirname, '../../package.json');
      const { stderr, exitCode, tmuxCalls } = runCLI(['open', notAPage]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('a preview shows .html and .md files');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses a file that does not exist', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['open', '/no/such/notes.md']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not a file: /no/such/notes.md');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses an unknown option', () => {
      const { stderr, exitCode } = runCLI(['open', '--bogus', 'notes.md']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown option: --bogus');
    });
  });
});
