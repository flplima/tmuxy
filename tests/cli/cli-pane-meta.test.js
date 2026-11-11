/**
 * `tmuxy pane meta`: the script resolves the pane and hands the rest to the
 * `meta` verb (`packages/tmuxy-verbs/src/meta_cli.rs`), whose rules are
 * tested in Rust and, against the real binary, in cli-guest-verbs.test.js.
 */

const { runCLI } = require('./helpers/run-cli');

const IN_PANE_1 = { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%1' };

const meta = (args, env = IN_PANE_1) => runCLI(['pane', 'meta', ...args], { env });

/** The `meta` verb's arguments, as the mock server printed them. */
function verbArgs(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('mock-server-started meta '));
  return line ? line.slice('mock-server-started '.length) : null;
}

describe('tmuxy pane meta', () => {
  test('with no target the fields are the caller’s own pane’s', () => {
    const { exitCode, stdout } = meta(['set', 'ci=passing', 'task=parser rewrite']);
    expect(exitCode).toBe(0);
    expect(verbArgs(stdout)).toBe('meta --target %1 set -- ci=passing task=parser rewrite');
  });

  test('a target, a label and a time to live are passed on; --json goes to the verb', () => {
    expect(verbArgs(meta(['set', '-t', '%3', '--ttl', '5m', 'deploy=running']).stdout)).toBe(
      'meta --target %3 set --ttl 5m -- deploy=running',
    );
    expect(verbArgs(meta(['unset', '-t%3', 'deploy']).stdout)).toBe(
      'meta --target %3 unset -- deploy',
    );
    const labelled = meta(['list', '-t', 'build'], {
      ...IN_PANE_1,
      MOCK_TMUX_LABELS: '%7\\tbuild\\t\\tmain:0',
    });
    expect(verbArgs(labelled.stdout)).toBe('meta --target %7 list --');
    expect(verbArgs(runCLI(['--json', 'pane', 'meta', 'clear'], { env: IN_PANE_1 }).stdout)).toBe(
      'meta --target %1 --json clear --',
    );
  });

  test('a mistake is a usage error, with nothing handed on', () => {
    for (const args of [['frob'], ['set', '--color', 'x=y'], ['unset', '--ttl', '5m', 'x']]) {
      const { exitCode, stdout } = meta(args);
      expect(exitCode).toBe(2);
      expect(verbArgs(stdout)).toBeNull();
    }
    // Outside any pane, and no -t: nothing to set fields on.
    const nowhere = meta(['set', 'x=y'], { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '' });
    expect(nowhere.exitCode).toBe(2);
    expect(nowhere.stderr).toContain('pass -t');
  });

  test('--help explains itself without touching tmux', () => {
    for (const args of [[], ['--help'], ['set', '--help']]) {
      const { exitCode, stdout, tmuxCalls } = meta(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('tmuxy pane meta set [-t target] [--ttl 5m] key=value...');
      expect(tmuxCalls).toEqual([]);
    }
  });
});
