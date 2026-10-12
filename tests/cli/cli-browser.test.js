/**
 * `tmuxy browser` — the CLI's half of the browser pane.
 *
 * The CLI does not drive the engine; it hands the whole command line to the
 * server binary, which turns the pane into a browser. So what is testable here
 * is the dispatch and the help, and that is also what breaks: an argument lost
 * on the way through is a page that silently does not open.
 */

const { runCLI } = require('./helpers/run-cli');

describe('tmuxy browser', () => {
  test('hands the page and the options to the server binary', () => {
    const { stdout, exitCode } = runCLI([
      'browser',
      '--session',
      'agent1',
      '--color-filter',
      'example.com',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
    expect(stdout).toContain('browser --session agent1 --color-filter example.com');
  });

  test('--attach reaches the binary', () => {
    const attach = runCLI(['browser', '--attach', 'ws://127.0.0.1:1/x']);
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
    expect(stdout).toContain('--attach');
    expect(stdout).toContain('--color-filter');
    expect(stdout).toContain('chrome://inspect');
    // The pane is driven by typing verbs into it; each must be discoverable.
    for (const verb of ['goto', 'eval', 'click', 'type', 'wait', 'text', 'shot', 'forward']) {
      expect(stdout).toContain(verb);
    }
  });

  test('the root help lists the command', () => {
    const { stdout } = runCLI(['--help']);
    expect(stdout).toContain('browser');
  });
});

describe('tmuxy open on a website', () => {
  // A frame cannot show a site that refuses to be framed, and WebKit shows the
  // refusal as a blank pane: a website goes to the real engine instead.
  test.each([
    [['open', 'example.com'], 'browser https://example.com'],
    [['open', 'localhost:3000'], 'browser http://localhost:3000'],
    [
      ['open', '--color-filter', 'https://example.com/a'],
      'browser --color-filter https://example.com/a',
    ],
    [['widget', 'browser', 'example.com'], 'browser https://example.com'],
  ])('%j opens in the browser pane', (args, handedOn) => {
    const { stdout, exitCode } = runCLI(args);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mock-server-started');
    expect(stdout).toContain(handedOn);
  });
});
