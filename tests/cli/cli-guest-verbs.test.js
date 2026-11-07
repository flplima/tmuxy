const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { guestMachine } = require('./helpers/guest-verbs');

/**
 * The in-browser guests (the v86 snapshot behind the demo and the v86
 * stories, the CheerpX image) have no tmuxy-server: the CLI's Rust verbs run
 * there from `tmuxy-verbs`, built without the `native` feature. Here the real
 * binary, built that way, is the only one on PATH, against the mock tmux:
 * every command written in Rust reaches it, and one that needs the server
 * answers as not available, under the CLI's contract, rather than as a
 * missing binary.
 */
describe('CLI on a machine with only the guest verbs binary', () => {
  let machine;

  beforeAll(() => {
    machine = guestMachine();
  }, 600_000);

  afterAll(() => machine?.remove());

  function guest(args, env = {}) {
    return runCLI(args, {
      cli: machine.cli,
      path: machine.path,
      env: { HOME: machine.home, TMUX_BIN: '', TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%5', ...env },
    });
  }

  test('pane float makes the float and answers its pane', () => {
    const { stdout, stderr, exitCode, tmuxCalls } = guest(['pane', 'float'], {
      MOCK_TMUX_WINDOW_ID: '@3',
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('%99');
    const made = tmuxCalls.find((c) => c.args[0] === 'run-shell');
    expect(made.args[1]).toContain('split-window -t %5');
    expect(made.args[1]).toContain('@tmuxy-window-type float');
  });

  test('tab create makes the tab beside the caller and answers its id', () => {
    const { stdout, exitCode, tmuxCalls } = guest(['tab', 'create', 'logs', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, tabId: '@99' });
    expect(tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1]).toContain('breakp -n logs');
  });

  test('run hands a reading command to tmux inside run-shell', () => {
    const { exitCode, tmuxCalls } = guest(['run', 'list-panes']);
    expect(exitCode).toBe(0);
    const ran = tmuxCalls.find((c) => c.args[0] === 'run-shell');
    expect(ran.target).toBe('%5');
    expect(ran.args[1]).toMatch(/tmux -L tmuxy list-panes/);
  });

  // Into the caller's own pane, which asks nobody: the pane's process is an
  // ancestor of the CLI (jest itself).
  test('pane send types the keys into the caller’s pane', () => {
    const { exitCode, tmuxCalls } = guest(['pane', 'send', 'echo', 'hi'], {
      MOCK_TMUX_PANE_PID: String(process.pid),
    });
    expect(exitCode).toBe(0);
    const sent = tmuxCalls.filter((c) => c.args[0] === 'run-shell').map((c) => c.args[1]);
    expect(sent).toEqual([expect.stringMatching(/send-keys -t %5 .*echo/)]);
  });

  test('config paths answers the files', () => {
    const { stdout, exitCode } = guest(['config', 'paths', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).dirs.config).toBe(path.join(machine.home, '.config', 'tmuxy'));
  });

  test('skill prints the agent guide', () => {
    const { stdout, exitCode } = guest(['skill']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('name: tmuxy');
  });

  test('pane capture --format html renders the colours as spans', () => {
    const { stdout, stderr, exitCode } = guest(['pane', 'capture', '--format', 'html'], {
      MOCK_TMUX_CAPTURE: '\x1b[1;31mFAIL\x1b[0m <a> \x1b[38;5;208mx\x1b[39m',
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      '<pre class="tmuxy-capture">\n' +
        '<span class="bold fg-1">FAIL</span> &lt;a&gt; <span class="fg-208">x</span>\n' +
        '</pre>\n',
    );
  });

  // `pane group` runs the pane-group script inside run-shell, which the mock
  // does not play; the script is run here as run-shell would run it.
  test('the pane-group script runs the group verb', () => {
    const { stderr, exitCode } = machine.runScript('pane-group', ['move', '%4', 'x'], {
      TMUX_SOCKET: 'tmuxy',
    });
    expect(stderr).toContain('pane-group move:');
    expect(stderr).not.toContain('not found');
    expect(exitCode).toBe(1);
  });

  test.each([
    [['session', 'snapshots'], 'session'],
    [['session', 'connect'], 'session-connect'],
    [['plugin', 'list'], 'plugin'],
    [['trace'], 'trace'],
  ])('%j needs the server: a contract failure naming it', (args, verb) => {
    const json = guest([...args, '--json']);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: `\`${verb}\` is not available here: it needs tmuxy-server, which this machine does not have`,
      code: 1,
    });
    const text = guest(args);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain(`Error: \`${verb}\` is not available here`);
  });
});
