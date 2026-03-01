const { runCLI } = require('./helpers/run-cli');

describe('CLI dispatch', () => {
  test('no args shows usage', () => {
    const { stdout, exitCode } = runCLI([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy <command>');
    expect(stdout).toContain('pane');
    expect(stdout).toContain('tab');
    expect(stdout).toContain('nav');
    expect(stdout).toContain('widget');
    expect(stdout).toContain('run');
    expect(stdout).toContain('server');
  });

  test('--help shows usage', () => {
    const { stdout, exitCode } = runCLI(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy <command>');
  });

  test('-h shows usage', () => {
    const { stdout, exitCode } = runCLI(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy <command>');
  });

  test('unknown command fails with error', () => {
    const { stderr, exitCode } = runCLI(['foobar']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command: foobar');
    expect(stderr).toContain('Usage: tmuxy <command>');
  });

  test('unknown command with arguments fails', () => {
    const { stderr, exitCode } = runCLI(['nonexistent', '--flag']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command: nonexistent');
  });

  test('dispatches to pane subcommand', () => {
    const { stdout, exitCode } = runCLI(['pane', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy pane <command>');
  });

  test('dispatches to tab subcommand', () => {
    const { stdout, exitCode } = runCLI(['tab', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy tab <command>');
  });

  test('dispatches to widget subcommand', () => {
    const { stdout, exitCode } = runCLI(['widget', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy widget <command>');
  });

  test('dispatches to nav subcommand', () => {
    const { stdout, exitCode } = runCLI(['nav', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy nav <direction>');
  });

  test('dispatches to run subcommand', () => {
    const { stdout, exitCode } = runCLI(['run', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy run <tmux-command>');
  });
});
