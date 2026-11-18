const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy pane ask` reads its command line, resolves the target and the
 * caller as `tmuxy pane send` does, and hands the rest to the server
 * binary's `ask` verb. What the verb refuses in the question itself (its
 * length, a control character, --choice with --text) is the verb's
 * (`packages/tmuxy-verbs/src/ask_cli/tests.rs`, and through the real binary
 * `cli-guest-verbs.test.js`); the question and its answer are the
 * protocol's (`packages/tmuxy-core/src/ask/tests.rs`). Here, the mock server
 * prints the command line it was given.
 */

/**
 * The environment of a caller running in pane %1: the pane's process is an
 * ancestor of the CLI (jest itself), which is what makes the claim true.
 */
const IN_PANE_1 = {
  TMUX_PANE: '%1',
  MOCK_TMUX_PANE_PID: String(process.pid),
};

const ask = (args, env = IN_PANE_1) => runCLI(['pane', 'ask', ...args], { env });

/** The `ask` verb's arguments, as the mock server printed them. */
function verbArgs(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('mock-server-started ask '));
  return line ? line.slice('mock-server-started '.length) : null;
}

describe('tmuxy pane ask', () => {
  test('asks over the caller’s own pane, and hands on the choices, the wait and JSON', () => {
    const { exitCode, stdout } = ask([
      'Deploy?',
      '--choice',
      'yes',
      '--choice',
      '-no, not yet',
      '--for',
      '30s',
      '--json',
    ]);
    expect(exitCode).toBe(0);
    expect(verbArgs(stdout)).toMatch(
      /^ask --target %1 --caller-pane %1 --caller-process \S* --choice yes --choice -no, not yet --for 30s --json -- Deploy\?$/,
    );
    const text = ask(['-t', '%3', '--text', '--', '-v or -q?']);
    expect(verbArgs(text.stdout)).toMatch(
      /^ask --target %3 --caller-pane %1 .* --text -- -v or -q\?$/,
    );
  });

  test('a command line it cannot read is exit 2, and nothing is asked', () => {
    for (const [args, says] of [
      [[], 'a question is required'],
      [['--choice', 'yes'], 'a question is required'],
      [['Deploy?', '--choice'], '--choice needs a value'],
      [['Deploy?', '--for'], '--for needs a value'],
      [['Deploy?', '-X'], "unknown option '-X'"],
    ]) {
      const { exitCode, stderr, stdout } = ask(args);
      expect({ args, exitCode }).toEqual({ args, exitCode: 2 });
      expect(stderr).toContain(says);
      expect(verbArgs(stdout)).toBeNull();
    }
    const json = ask(['--json', '--choice', 'yes']);
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: 'a question is required',
      code: 2,
    });
  });

  test('a pane that is not there is exit 3, and nothing is asked', () => {
    const { exitCode, stdout, stderr } = ask(['-t', '%7', 'Deploy?'], {
      ...IN_PANE_1,
      MOCK_TMUX_GONE_PANES: '%7',
      MOCK_TMUX_GONE_ANSWERS_AS: '',
    });
    expect(exitCode).toBe(3);
    expect(stderr).toContain('no such pane: %7');
    expect(verbArgs(stdout)).toBeNull();
  });
});
