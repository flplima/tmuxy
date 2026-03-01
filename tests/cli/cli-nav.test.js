const { runCLI } = require('./helpers/run-cli');

describe('CLI nav subcommand', () => {
  describe('help output', () => {
    test('no args shows usage', () => {
      const { stdout, exitCode } = runCLI(['nav']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy nav <direction>');
    });

    test('--help shows usage', () => {
      const { stdout, exitCode } = runCLI(['nav', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy nav <direction>');
    });

    test('-h shows usage', () => {
      const { stdout, exitCode } = runCLI(['nav', '-h']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy nav <direction>');
    });

    test('help lists all directions', () => {
      const { stdout } = runCLI(['nav', '--help']);
      expect(stdout).toContain('left');
      expect(stdout).toContain('right');
      expect(stdout).toContain('up');
      expect(stdout).toContain('down');
      expect(stdout).toContain('next');
      expect(stdout).toContain('prev');
    });
  });

  describe('direction dispatch', () => {
    test('left dispatches run-shell with nav.sh left', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'left']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh left');
    });

    test('right dispatches run-shell with nav.sh right', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'right']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh right');
    });

    test('up dispatches run-shell with nav.sh up', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'up']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh up');
    });

    test('down dispatches run-shell with nav.sh down', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'down']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh down');
    });

    test('next dispatches run-shell with nav.sh next', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'next']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh next');
    });

    test('prev dispatches run-shell with nav.sh prev', () => {
      const { exitCode, tmuxCalls } = runCLI(['nav', 'prev']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toContain('nav.sh prev');
    });
  });

  describe('run-shell args include pane_id', () => {
    test('direction commands include #{pane_id} in run-shell arg', () => {
      const { tmuxCalls } = runCLI(['nav', 'right']);
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });

    test('prev includes #{pane_id} in run-shell arg', () => {
      const { tmuxCalls } = runCLI(['nav', 'prev']);
      expect(tmuxCalls[0].args[1]).toContain('#{pane_id}');
    });
  });

  describe('error handling', () => {
    test('unknown direction shows error', () => {
      const { stderr, exitCode } = runCLI(['nav', 'diagonal']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown direction: diagonal');
    });

    test('unknown direction shows usage in stderr', () => {
      const { stderr } = runCLI(['nav', 'foobar']);
      expect(stderr).toContain('Usage: tmuxy nav <direction>');
    });

    test('unknown direction makes no tmux calls', () => {
      const { tmuxCalls } = runCLI(['nav', 'invalid']);
      expect(tmuxCalls).toHaveLength(0);
    });
  });
});
