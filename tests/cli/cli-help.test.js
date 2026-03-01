const { runCLI } = require('./helpers/run-cli');

describe('CLI help output', () => {
  describe('top-level help', () => {
    test.each([
      [[], 'Usage: tmuxy <command>'],
      [['--help'], 'Usage: tmuxy <command>'],
      [['-h'], 'Usage: tmuxy <command>'],
    ])('tmuxy %j shows top-level usage', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('pane help', () => {
    test.each([
      [['pane'], 'Usage: tmuxy pane <command>'],
      [['pane', '--help'], 'Usage: tmuxy pane <command>'],
      [['pane', '-h'], 'Usage: tmuxy pane <command>'],
    ])('tmuxy %j shows pane usage', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('pane subcommand help', () => {
    test.each([
      [['pane', 'list', '--help'], 'Usage: tmuxy pane list'],
      [['pane', 'list', '-h'], 'Usage: tmuxy pane list'],
      [['pane', 'split', '--help'], 'Usage: tmuxy pane split'],
      [['pane', 'split', '-h'], 'Usage: tmuxy pane split'],
      [['pane', 'kill', '--help'], 'Usage: tmuxy pane kill'],
      [['pane', 'kill', '-h'], 'Usage: tmuxy pane kill'],
      [['pane', 'select', '--help'], 'Usage: tmuxy pane select'],
      [['pane', 'select', '-h'], 'Usage: tmuxy pane select'],
      [['pane', 'resize', '--help'], 'Usage: tmuxy pane resize'],
      [['pane', 'resize', '-h'], 'Usage: tmuxy pane resize'],
      [['pane', 'swap', '--help'], 'Usage: tmuxy pane swap'],
      [['pane', 'swap', '-h'], 'Usage: tmuxy pane swap'],
      [['pane', 'zoom', '--help'], 'Usage: tmuxy pane zoom'],
      [['pane', 'zoom', '-h'], 'Usage: tmuxy pane zoom'],
      [['pane', 'break', '--help'], 'Usage: tmuxy pane break'],
      [['pane', 'break', '-h'], 'Usage: tmuxy pane break'],
      [['pane', 'capture', '--help'], 'Usage: tmuxy pane capture'],
      [['pane', 'capture', '-h'], 'Usage: tmuxy pane capture'],
      [['pane', 'send', '--help'], 'Usage: tmuxy pane send'],
      [['pane', 'send', '-h'], 'Usage: tmuxy pane send'],
      [['pane', 'paste', '--help'], 'Usage: tmuxy pane paste'],
      [['pane', 'paste', '-h'], 'Usage: tmuxy pane paste'],
      [['pane', 'float', '--help'], 'Usage: tmuxy pane float'],
      [['pane', 'float', '-h'], 'Usage: tmuxy pane float'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('pane group help', () => {
    test.each([
      [['pane', 'group'], 'Usage: tmuxy pane group <command>'],
      [['pane', 'group', '--help'], 'Usage: tmuxy pane group <command>'],
      [['pane', 'group', '-h'], 'Usage: tmuxy pane group <command>'],
      [['pane', 'group', 'add', '--help'], 'Usage: tmuxy pane group add'],
      [['pane', 'group', 'close', '--help'], 'Usage: tmuxy pane group close'],
      [['pane', 'group', 'switch', '--help'], 'Usage: tmuxy pane group switch'],
      [['pane', 'group', 'next', '--help'], 'Usage: tmuxy pane group next'],
      [['pane', 'group', 'prev', '--help'], 'Usage: tmuxy pane group prev'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('tab help', () => {
    test.each([
      [['tab'], 'Usage: tmuxy tab <command>'],
      [['tab', '--help'], 'Usage: tmuxy tab <command>'],
      [['tab', '-h'], 'Usage: tmuxy tab <command>'],
      [['tab', 'list', '--help'], 'Usage: tmuxy tab list'],
      [['tab', 'create', '--help'], 'Usage: tmuxy tab create'],
      [['tab', 'kill', '--help'], 'Usage: tmuxy tab kill'],
      [['tab', 'select', '--help'], 'Usage: tmuxy tab select'],
      [['tab', 'next', '--help'], 'Usage: tmuxy tab next'],
      [['tab', 'prev', '--help'], 'Usage: tmuxy tab prev'],
      [['tab', 'rename', '--help'], 'Usage: tmuxy tab rename'],
      [['tab', 'layout', '--help'], 'Usage: tmuxy tab layout'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('widget help', () => {
    test.each([
      [['widget'], 'Usage: tmuxy widget <command>'],
      [['widget', '--help'], 'Usage: tmuxy widget <command>'],
      [['widget', '-h'], 'Usage: tmuxy widget <command>'],
      [['widget', 'image', '--help'], 'Usage: tmuxy widget image'],
      [['widget', 'image', '-h'], 'Usage: tmuxy widget image'],
      [['widget', 'markdown', '--help'], 'Usage: tmuxy widget markdown'],
      [['widget', 'markdown', '-h'], 'Usage: tmuxy widget markdown'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('run help', () => {
    test.each([
      [['run', '--help'], 'Usage: tmuxy run <tmux-command>'],
      [['run', '-h'], 'Usage: tmuxy run <tmux-command>'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });
});
