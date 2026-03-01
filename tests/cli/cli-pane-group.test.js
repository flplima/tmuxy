const { runCLI } = require('./helpers/run-cli');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts/tmuxy');

describe('CLI pane group subcommands', () => {
  describe('pane group add', () => {
    test('execs run-shell with pane-group-add.sh', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'add']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-add.sh');
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });
  });

  describe('pane group close', () => {
    test('execs run-shell with pane-group-close.sh (no arg)', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'close']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-close.sh');
      // Default pane_id is #{pane_id} when no arg given
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });

    test('execs run-shell with pane-group-close.sh (specific pane)', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'close', '%5']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-close.sh');
      expect(tmuxCalls[0].args[1]).toContain('%5');
    });
  });

  describe('pane group switch', () => {
    test('execs run-shell with pane-group-switch.sh', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'switch', '%3']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-switch.sh');
      expect(tmuxCalls[0].args[1]).toContain('%3');
    });

    test('errors with no pane id', () => {
      const { stderr, exitCode } = runCLI(['pane', 'group', 'switch']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane group next', () => {
    test('execs run-shell with pane-group-next.sh', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'next']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-next.sh');
    });
  });

  describe('pane group prev', () => {
    test('execs run-shell with pane-group-prev.sh', () => {
      const { tmuxCalls } = runCLI(['pane', 'group', 'prev']);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('pane-group-prev.sh');
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
