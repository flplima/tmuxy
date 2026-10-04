/**
 * `tmuxy browser` — the CLI's half of the browser pane.
 *
 * The CLI does not drive the engine; it hands the whole command line to the
 * server binary, which launches a browser of its own. So what is testable here
 * is the dispatch and the help, and that is also what breaks: an argument lost
 * on the way through is a verb that silently does something else.
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

  test('--repl and --attach reach the binary', () => {
    const repl = runCLI(['browser', '--repl', '--session', 'agent1']);
    expect(repl.exitCode).toBe(0);
    expect(repl.stdout).toContain('--repl');
    // The flag used to be stripped here by a wrapper script, which left an
    // empty argument that swallowed `--session` into the verb line.
    expect(repl.stdout).toContain('--session');
    expect(repl.stdout).toContain('agent1');

    const attach = runCLI(['browser', '--repl', '--attach', 'ws://127.0.0.1:1/x']);
    expect(attach.exitCode).toBe(0);
    expect(attach.stdout).toContain('--attach');
    expect(attach.stdout).toContain('ws://127.0.0.1:1/x');
  });

  /// The help has to work with no server running and no browser installed —
  /// it is where someone finds out the engine is their own.
  test('--help is answered by the CLI itself, not the server', () => {
    const { stdout, exitCode } = runCLI(['browser', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('mock-server-started');
    expect(stdout).toContain('Usage: tmuxy browser');
    expect(stdout).toContain('TMUXY_CHROME');
    // Both ways in, since the help is where someone learns they exist.
    expect(stdout).toContain('--repl');
    expect(stdout).toContain('--attach');
    expect(stdout).toContain('chrome://inspect');
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
