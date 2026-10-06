const { runCLI } = require('./helpers/run-cli');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname, '../../bin/tmuxy');

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

  describe('pane group unknown', () => {
    test('errors on unknown group subcommand', () => {
      const { stderr, exitCode } = runCLI(['pane', 'group', 'badcmd']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown group command: badcmd');
      expect(stderr).toContain('Usage: tmuxy pane group <command>');
    });
  });
});
