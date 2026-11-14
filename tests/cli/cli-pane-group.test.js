const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { runGroupScript, runGroupScriptInBareTree } = require('./helpers/run-group-script');

const SCRIPTS_DIR = path.resolve(__dirname, '../../packages/tmuxy-cli/bin/tmuxy');
const MOCKS_DIR = path.resolve(__dirname, 'mocks');
const PANE_GROUP = `bash '${SCRIPTS_DIR}/pane-group'`;

/**
 * `tmuxy pane group <verb>` forwards to the pane-group script inside
 * run-shell: the verbs, their arguments, their defaults and their help are
 * the `group` verb's (packages/tmuxy-verbs/src/group_cli.rs; against a real
 * tmux in packages/tmuxy-server/tests/pane_groups.rs).
 */
describe('CLI pane group subcommands', () => {
  test.each([
    [['add'], "'add'"],
    [['close', '%5'], "'close' '%5'"],
    [['move', '%4', '0'], "'move' '%4' '0'"],
    [['leave', '%5', '--beside', '%2', 'down'], "'leave' '%5' '--beside' '%2' 'down'"],
    [['badcmd'], "'badcmd'"],
  ])('pane group %j hands the verb its words, quoted', (args, words) => {
    const { tmuxCalls } = runCLI(['pane', 'group', ...args]);
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].args[0]).toBe('run-shell');
    expect(tmuxCalls[0].args[1]).toBe(`${PANE_GROUP} ${words}`);
  });

  // run-shell hands its string to a shell, so an argument with a quote in it
  // must reach the script as one word, never as more of the command.
  test('a pane with a quote in it stays one word', () => {
    const { tmuxCalls } = runCLI(['pane', 'group', 'close', "%1'; id; '"]);
    expect(tmuxCalls[0].args[1]).toBe(`${PANE_GROUP} 'close' '%1'\\''; id; '\\'''`);
  });

  test('--json reaches the verb, which answers', () => {
    const { tmuxCalls } = runCLI(['pane', 'group', 'next', '--json']);
    expect(tmuxCalls[0].args[1]).toBe(`${PANE_GROUP} 'next' --json`);
  });

  // A verb left without a pane takes the caller's: run-shell's target, and
  // the TMUX_PANE the verb reads, from the environment or from the
  // dispatcher's own resolution.
  describe("the caller's pane", () => {
    test('rides along from the environment', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'ungroup'], {
        env: { TMUX_PANE: '%7' },
      });
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].target).toBe('%7');
      expect(tmuxCalls[0].args[1]).toBe(`TMUX_PANE=%7 ${PANE_GROUP} 'ungroup'`);
    });

    test('from outside a pane, is the resolved one', () => {
      const { tmuxCalls, paneResolution } = runCLI(['pane', 'group', 'add'], {
        env: { MOCK_TMUX_CALLER_PANES: '0\\tidle\\t%3\\n1\\tmain\\t%0' },
      });
      expect(paneResolution).not.toBeNull();
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].target).toBe('%0');
      expect(tmuxCalls[0].args[1]).toBe(`TMUX_PANE=%0 ${PANE_GROUP} 'add'`);
    });

    test('with no pane known, run-shell goes target-less', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'add']);
      expect(tmuxCalls[0].target).toBeUndefined();
    });
  });

  test.each([[['--help']], [[]], [['leave', '--help']]])(
    'pane group %j asks the verb for its help, and runs nothing',
    (args) => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'group', ...args]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toEqual([]);
      expect(stdout.trim()).toBe(`mock-server-started group ${args.join(' ') || '--help'}`);
    },
  );

  describe('the pane-group script', () => {
    test.each([
      ['add', ['%1', '80', '24'], 'group add %1 80 24'],
      ['close', ['%5'], 'group close %5'],
      ['join', ['%9', '%4', '1'], 'group join %9 %4 1'],
      ['leave', ['%5', '--beside', '%2', 'up'], 'group leave %5 --beside %2 up'],
      ['park', ['work:0.0', 'g1', '/tmp', '2'], 'group park work:0.0 g1 /tmp 2'],
    ])('%s hands its arguments to the server binary', (verb, args, expected) => {
      const { stdout, exitCode } = runGroupScript(verb, args);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(`server ${expected}`);
    });

    test("keeps the binary's output and exit status", () => {
      const { stdout, exitCode } = runGroupScript('join', ['%1', '%1'], {
        STUB_EXIT: '1',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('group join %1 %1');
    });

    test('prefers the binary the running tmuxy published, with its subcommand', () => {
      const { stdout } = runGroupScript('close', ['%5'], {
        TMUXY_SERVER_BIN: path.join(MOCKS_DIR, 'tmuxy-server'),
        TMUXY_SERVER_SUBCOMMAND: 'server',
      });
      expect(stdout).toBe('mock-server-started server group close %5');
    });

    // A dev tree with nothing installed (CI): the server build is found from
    // where the scripts sit in the repo.
    test("finds the dev tree's own server build, from the scripts' place in the repo", () => {
      const { stdout, stderr, exitCode } = runGroupScriptInBareTree('next', ['%1']);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(stdout).toBe('dev build group next %1');
    });
  });
});
