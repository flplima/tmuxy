const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy pane send` reads its command line, resolves the target and the
 * caller, and hands the rest to the server binary's `send` verb, which asks
 * the user before typing into a pane that is not the caller's own. The
 * question, the allow options and the exit code of each refusal are that
 * verb's (`packages/tmuxy-verbs/src/send_cli/tests.rs`) and the protocol's
 * (`packages/tmuxy-core/src/ask/tests.rs`); here, the mock server prints the
 * command line it was given.
 */

/**
 * The environment of a caller running in pane %1: the pane's process is an
 * ancestor of the CLI (jest itself), which is what makes the claim true.
 */
const IN_PANE_1 = {
  TMUX_SOCKET: 'tmuxy',
  TMUX_PANE: '%1',
  MOCK_TMUX_PANE_PID: String(process.pid),
};

const send = (args, env = {}) => runCLI(['pane', 'send', ...args], { env });

/** The `send` verb's arguments, as the mock server printed them. */
function verbArgs(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('mock-server-started send '));
  return line ? line.slice('mock-server-started '.length) : null;
}

describe('tmuxy pane send', () => {
  test('with no target the keys go to the caller’s own pane, named as such', () => {
    const { exitCode, stdout } = send(['ls', 'Enter'], IN_PANE_1);
    expect(exitCode).toBe(0);
    expect(verbArgs(stdout)).toMatch(
      /^send --target %1 --caller-pane %1 --caller-process \S* -- ls Enter$/,
    );
  });

  test('a key that looks like a flag is typed, never read as one', () => {
    const { stdout } = send(['--', '-t', '%3', 'id', 'Enter'], IN_PANE_1);
    expect(verbArgs(stdout)).toMatch(/ -- -t %3 id Enter$/);
  });

  test('-t%3, run together, still names the target', () => {
    const { stdout } = send(['-t%3', 'id', 'Enter'], IN_PANE_1);
    expect(verbArgs(stdout)).toMatch(/^send --target %3 --caller-pane %1 /);
  });

  test('a label names the pane it labels', () => {
    const { stdout } = send(['-t', 'build', 'make'], {
      ...IN_PANE_1,
      MOCK_TMUX_LABELS: '%7\\tbuild\\t\\tmain:0',
    });
    expect(verbArgs(stdout)).toMatch(/^send --target %7 /);
  });

  test('a caller in no pane names none, and the keys go to the pane in view', () => {
    const { stdout } = send(['ls', 'Enter'], {
      TMUX_SOCKET: 'tmuxy',
      MOCK_TMUX_CALLER_PANES: '1\\tmain\\t%2',
      MOCK_TMUX_PANE_ID: '%2',
    });
    expect(verbArgs(stdout)).toMatch(/^send --target %2 --caller-pane {2}--caller-process /);
  });

  test('claiming the target as your own pane is not believed', () => {
    const { stdout } = send(['-t', '%3', 'id', 'Enter'], {
      TMUX_SOCKET: 'tmuxy',
      TMUX_PANE: '%3',
      MOCK_TMUX_PANE_PID: '999999',
    });
    expect(verbArgs(stdout)).toMatch(/^send --target %3 --caller-pane {2}/);
  });

  test('passes on the timeout, the paste and the JSON mode', () => {
    const { stdout } = runCLI(['pane', 'send', '-t', '%3', '--timeout', '30', '--json', 'ls'], {
      env: IN_PANE_1,
    });
    expect(verbArgs(stdout)).toMatch(/ --timeout 30 --json -- ls$/);
    const paste = runCLI(['pane', 'paste', '-t', '%3', 'some text'], { env: IN_PANE_1 });
    expect(verbArgs(paste.stdout)).toMatch(/ --paste -- some text$/);
  });

  describe('refusals', () => {
    test('needs keys to send', () => {
      const { exitCode, stderr } = send(['-t', '%3']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('keys required');
    });

    test('rejects a non-numeric timeout', () => {
      const { exitCode, stderr } = send(['-t', '%3', '--timeout', 'soon', 'ls']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('--timeout');
    });

    test('an unknown flag is refused rather than handed on', () => {
      const { exitCode, stderr, stdout } = send(['-X', 'cancel'], IN_PANE_1);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("unknown option '-X'");
      expect(verbArgs(stdout)).toBeNull();
    });

    test('a target that is not a pane is exit 3, and nothing is handed on', () => {
      const { exitCode, stdout } = send(['-t', 'nobody', 'ls'], IN_PANE_1);
      expect(exitCode).toBe(3);
      expect(verbArgs(stdout)).toBeNull();
    });
  });

  test('--help explains itself without touching tmux', () => {
    const { stdout, exitCode, tmuxCalls } = send(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy pane send');
    expect(stdout).toContain('@tmuxy-send-allow');
    expect(tmuxCalls).toHaveLength(0);
  });

  test('ask is no longer a command', () => {
    const { exitCode } = runCLI(['ask', '%3', 'ls']);
    expect(exitCode).not.toBe(0);
  });
});
