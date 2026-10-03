/**
 * `tmuxy browser` — the CLI's half of the server-side browser.
 *
 * The CLI does not drive the engine; it hands the verb line to the server
 * binary, which talks to the running server. So what is testable here is the
 * dispatch and the help, and that is also what breaks: an argument lost on the
 * way through is a verb that silently does something else.
 */

const { runCLI } = require('./helpers/run-cli');

describe('tmuxy browser', () => {
  test('hands the verb line to the server binary', () => {
    const { stdout, exitCode } = runCLI(['browser', 'goto', 'example.com']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
    // The subcommand and every argument after it, in order: `goto example.com`
    // arriving as `example.com goto` would navigate nowhere and say nothing.
    expect(stdout).toContain('browser');
    expect(stdout).toContain('goto');
    expect(stdout).toContain('example.com');
  });

  test('passes --session through', () => {
    const { stdout, exitCode } = runCLI(['browser', '--session', 'agent1', 'title']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--session');
    expect(stdout).toContain('agent1');
    expect(stdout).toContain('title');
  });

  /// A selector with spaces is the normal case (`div.card > button`), and the
  /// whole grammar depends on it arriving as one argument rather than three.
  test('keeps a multi-word selector together', () => {
    const { stdout, exitCode } = runCLI(['browser', 'click', 'div.card > button']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('div.card > button');
  });

  test('--repl, --close and --list reach the server', () => {
    for (const flag of ['--repl', '--close', '--list']) {
      const { stdout, exitCode } = runCLI(['browser', flag]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(flag);
    }
  });

  /// The help has to work with no server running and no browser installed —
  /// it is where someone finds out the engine is their own.
  test('--help is answered by the CLI itself, not the server', () => {
    const { stdout, exitCode } = runCLI(['browser', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('mock-server-started');
    expect(stdout).toContain('Usage: tmuxy browser');
    expect(stdout).toContain('TMUXY_CHROME');
    // Every verb the server parses must be discoverable here.
    for (const verb of ['goto', 'eval', 'click', 'type', 'wait', 'text', 'shot']) {
      expect(stdout).toContain(verb);
    }
  });

  test('the root help lists the command', () => {
    const { stdout } = runCLI(['--help']);
    expect(stdout).toContain('browser');
  });
});
