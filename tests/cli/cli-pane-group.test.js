const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { runGroupScript } = require('./helpers/run-group-script');

const SCRIPTS_DIR = path.resolve(__dirname, '../../bin/tmuxy');
const MOCKS_DIR = path.resolve(__dirname, 'mocks');

describe('CLI pane group subcommands', () => {
  describe('pane group add', () => {
    test('execs run-shell with pane-group-add', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'add']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-add');
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });
  });

  describe('pane group close', () => {
    test('execs run-shell with pane-group-close (no arg)', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'close']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-close');
      // Default pane_id is #{pane_id} when no arg given
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });

    test('execs run-shell with pane-group-close (specific pane)', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'close', '%5']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-close');
      expect(tmuxCalls[0].args[1]).toContain('%5');
    });
  });

  describe('pane group switch', () => {
    test('execs run-shell with pane-group-switch', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'switch', '%3']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-switch');
      expect(tmuxCalls[0].args[1]).toContain('%3');
    });

    test('errors with no pane id', () => {
      const { stderr, exitCode } = runCLI(['pane', 'group', 'switch']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane group next', () => {
    test('execs run-shell with pane-group-next', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'next']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-next');
    });
  });

  describe('pane group prev', () => {
    test('execs run-shell with pane-group-prev', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'prev']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-prev');
    });
  });

  describe('pane group move', () => {
    test('execs run-shell with pane-group-move, the pane and its new place', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'move', '%4', '0']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(/pane-group-move' '%4' '0'$/);
    });

    test('errors without a place', () => {
      const { exitCode } = runCLI(['pane', 'group', 'move', '%4']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane group join', () => {
    test('execs run-shell with pane-group-join, the pane, the member and the place', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'join', '%9', '%4', '1']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[1]).toMatch(/pane-group-join' '%9' '%4' '1'$/);
    });

    test('errors without a group to join', () => {
      const { exitCode } = runCLI(['pane', 'group', 'join', '%9']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane group leave', () => {
    test('becomes a tab of its own by default', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'leave', '%5']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[1]).toContain("pane-group-leave' '%5' '--tab'");
    });

    test('splits in beside a pane on the side named', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'leave', '%5', '--beside', '%2', 'down']);
      expect(tmuxCalls[0].args[1]).toMatch(/pane-group-leave' '%5' '--beside' '%2' 'down'$/);
    });
  });

  describe('the pane-group scripts', () => {
    test.each([
      ['pane-group-add', ['%1', '80', '24'], 'group add %1 80 24'],
      ['pane-group-close', ['%5'], 'group close %5'],
      ['pane-group-switch', ['%3'], 'group switch %3'],
      ['pane-group-next', ['%1'], 'group next %1'],
      ['pane-group-prev', ['%1'], 'group prev %1'],
      ['pane-group-move', ['%4', '0'], 'group move %4 0'],
      ['pane-group-join', ['%9', '%4', ''], 'group join %9 %4 '],
      ['pane-group-leave', ['%5', '--beside', '%2', 'up'], 'group leave %5 --beside %2 up'],
      ['pane-group-park', ['work:0.0', 'g1', '/tmp', '2'], 'group park work:0.0 g1 /tmp 2'],
    ])('%s hands its arguments to the server binary', (script, args, expected) => {
      const { stdout, exitCode } = runGroupScript(script, args);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(`server ${expected} [scripts=${SCRIPTS_DIR}]`);
    });

    test("keeps the binary's output and exit status", () => {
      const { stdout, exitCode } = runGroupScript('pane-group-join', ['%1', '%1'], {
        STUB_EXIT: '1',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('group join %1 %1');
    });

    test('prefers the binary the running tmuxy published, with its subcommand', () => {
      const { stdout } = runGroupScript('pane-group-close', ['%5'], {
        TMUXY_SERVER_BIN: path.join(MOCKS_DIR, 'tmuxy-server'),
        TMUXY_SERVER_SUBCOMMAND: 'server',
      });
      expect(stdout).toBe('mock-server-started server group close %5');
    });
  });

  describe('pane group unknown', () => {
    test('errors on unknown group subcommand', () => {
      const { stderr, exitCode } = runCLI(['pane', 'group', 'badcmd']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown group command: badcmd');
      expect(stderr).toContain('Usage: tmuxy pane group <command>');
    });
  });
});
