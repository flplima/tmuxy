const { runCLI } = require('./helpers/run-cli');

describe('tmuxy open', () => {
  test('shows help, and is the browser widget spelled short', () => {
    const { stdout, exitCode } = runCLI(['open', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy open');
    expect(stdout).toContain('tmuxy widget browser');
  });

  test('errors with no target', () => {
    const { stderr, exitCode } = runCLI(['open']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('file, url or host required');
  });

  // The address-bar reading of a scheme-less target: only when no such file
  // exists, and only for things shaped like an address.
  test.each([
    ['localhost', 'http://localhost'],
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost:3000/api', 'http://localhost:3000/api'],
    ['127.0.0.1', 'http://127.0.0.1'],
    ['192.168.1.10:8080/x', 'http://192.168.1.10:8080/x'],
    ['example.com', 'https://example.com'],
    ['docs.example.co.uk/guide?x=1', 'https://docs.example.co.uk/guide?x=1'],
    ['https://example.com/a', 'https://example.com/a'],
  ])('%s resolves to %s', (target, url) => {
    const { stdout, exitCode } = runCLI(['open', '--resolve', target]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(url);
  });

  test('a file that exists wins over an address-shaped name', () => {
    const { stdout, exitCode } = runCLI(['open', '--resolve', 'package.json']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\/package\.json$/);
  });

  test('a name that is neither a file nor an address is still not found', () => {
    for (const target of ['notes', 'notes.md', '/tmp/tmuxy-no-such-file.html']) {
      const { stderr, exitCode } = runCLI(['open', '--resolve', target]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('File not found');
    }
  });
});

describe('CLI widget subcommands', () => {
  // The widget exec path uses `exec` to replace the process with
  // tmuxy-widget-browser, which pipes into tmuxy-widget's `trap 'exec bash
  // </dev/tty' EXIT` — that fails without a tty. We test only help and
  // missing-arg error cases.

  describe('widget browser', () => {
    test('shows help', () => {
      const { stdout, exitCode } = runCLI(['widget', 'browser', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy widget browser [--color-filter]');
    });

    test('--color-filter still needs a source', () => {
      const { stderr, exitCode } = runCLI(['widget', 'browser', '--color-filter']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage: tmuxy-widget-browser [--color-filter]');
    });

    test('errors with no source', () => {
      const { stderr, exitCode } = runCLI(['widget', 'browser']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('file, url or - required');
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
